// The daemon as a value: what it holds, built from its inputs, and its one close.

import fs from "node:fs";
import { linkSignerFromKeyFile } from "./link-key.js";
import { Runs } from "./runs.js";
import { inspect } from "node:util";
import { watchProbeDir, socketPath, stateDir } from "./paths";
import { dlog } from "./log";
import type { Request } from "./protocol";
import type { DaemonParts } from "./daemon-parts.js";
import { lanesAt, laneClicked, renderFrame, viewLanes } from "./draw-bar.js";
import {
  handleRequest,
  replyTo,
  type HandledRequest,
  type Reply,
  type ReplyRequest,
} from "./reply.js";
import type { CheckedRenderRequest } from "./render-checkpoint.js";
import type { SessionStorage } from "./session-state";
import type { HistoryStorage } from "./settings-history";
import { createLauncher, type Launcher, type Settled } from "../proc/launch";
import type { DaemonLogger } from "../utils/logger";
import { actsDir } from "./update-act";
import { makeUpdateWatch } from "./update-notice";
import { makeBinaryWatch } from "./binary-watch";
import { stableAttachPreload } from "../install/index.js";
import { type RenderOrigin } from "../config-hint";
import { createPayloadProviders } from "./payload-providers";
import { FileEventDelivery } from "./cache/file-events";
import { afterRealTime, type After } from "../utils/reading";
import { RefreshLedger } from "../utils/refresh-ledger";
import {
  configLoadedLine,
  RenderCache,
  renderCacheBudget,
} from "./cache/render";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
import { makeLimits, realLimitsDeps } from "./limits";
import { SessionState } from "./session-state";
import { SettingsHistory } from "./settings-history";
import { NavigationHistory } from "./navigation-history";
import { stateGate } from "./verbs/state-validators";
import { closeIdleMenus } from "./verbs";
import { fileStores, productionEdge } from "../doctor/edge";
import { ProbeArrivals } from "../doctor/handler-probe";
import { RenderSightings } from "./render-sightings";
import { declareLanes } from "./render-payload.js";
import { sessionSource, type SessionSource } from "./session-source.js";
import { EffectSessions } from "../render/effect.js";
import { FEED_PERIODS, FrameFeeds } from "./frame-feed.js";
import { type Drawing, type LaneSwitches } from "../config/lanes.js";
import {
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  PaneVisibility,
} from "./pane-visibility.js";
import { runTmux, runTmuxAsync } from "../proc/tmux.js";
import { TmuxStatusLines } from "./tmux-status.js";
import { shellWord } from "../shell-word.js";
import { reaction } from "mobx";
import { setImmediate } from "node:timers";
import type { RenderedLine } from "../dsl/node-registry.js";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { LaneSetups } from "./lane-setup.js";
import { productionLaneEdge } from "./lane-edge.js";
import { RenderWarningRecords } from "./render-warnings.js";
import { instantOf, type Instant } from "../utils/instant.js";
import { JournalTurns } from "./journal-turns.js";
import { MenuIdle } from "./menu-idle.js";

// How this daemon's node runs the bundle it was loaded from.
export interface RunningBundle {
  // The entry's own URL, whose checkout the update notice assesses.
  readonly entryUrl: string;
  // The digest of the source it was built from, `null` for one that carries
  // none: what the update notice assesses that checkout against, and what
  // daemon-stats tells one build of a version from another by.
  readonly digest: string | null;
  // The file the entry was loaded from, as the build watch and the update
  // notice read it: what daemon-stats and the doctor's click name the install
  // by.
  readonly path: string;
  // What a bar pane runs, and what a click in a tmux status line runs to hand
  // the click back.
  readonly node: readonly string[];
  // The files the binary watch stats: a change to any of them restarts the
  // daemon.
  readonly targets: readonly string[];
}

// [LAW:effects-at-boundaries] The two clocks a daemon draws and times requests
// by, as values, so a test can hold the instant a bar is drawn at. Its counters
// keep their own wall clock (RuntimeStats).
// [LAW:one-source-of-truth] `after` runs a request's wait and its backstop, on
// the same clock its budget is figured from, so a held clock holds all three.
export interface DaemonClock {
  date(): Date;
  monotonic(): number;
  after: After;
}

export const SYSTEM_CLOCK: DaemonClock = {
  date: () => new Date(),
  monotonic: () => performance.now(),
  after: afterRealTime,
};

// Where the session's picks and its settings history persist.
export interface DaemonStorage {
  readonly session: SessionStorage;
  readonly history: HistoryStorage;
}

// What a daemon takes from the process that runs it. Paths are not among them:
// the log, the repository answers and the post-mortems read src/daemon/paths.ts
// when they write, so a path passed here would be honoured by half the daemon
// and the state directory would split with nothing to say so.
// [LAW:one-source-of-truth] The environment is the one source.
export interface DaemonInputs {
  readonly bundle: RunningBundle;
  // Their files, for a daemon that won the socket, which makes it their sole
  // writer. Built over the daemon's log: a write in flight at the close finishes
  // after it, and what it logs says so like any other line of the daemon's work.
  readonly storage: (log: DaemonLogger) => DaemonStorage;
  readonly memoryLimitBytes: number;
  readonly registryUrl: string;
  readonly clock: DaemonClock;
  // [LAW:single-enforcer] The process's one death funnel: the binary watch and
  // the memory backstop end the daemon here, never on their own.
  readonly exit: (code: number) => void;
}

// The daemon as a value: built by `createDaemon`, driven by calling `handle`,
// ended by `close`. Everything about a process — a socket, signals, an exit —
// is server.ts's, over this; `exit` is only the funnel it handed in.
export interface Daemon {
  readonly stats: RuntimeStats;
  // What this daemon's work launches through: its close refuses them all.
  readonly launcher: Launcher;
  // What this daemon's work logs through.
  readonly log: DaemonLogger;
  readonly memoryLimitBytes: number;
  readonly clock: DaemonClock;
  // [LAW:one-source-of-truth] The funnel this daemon was built with, which a
  // connection reaches once a reply carrying an exit has flushed.
  readonly exit: DaemonInputs["exit"];
  // The request handling a connection calls. `accepted` is when its connection
  // came in, on `clock`'s monotonic reading.
  readonly handle: (
    req: Request,
    timedOut: () => boolean,
    accepted: number,
  ) => Promise<HandledRequest>;
  // The reply to a request of any kind but a subscribe, past the connection's
  // checkpoint: what the page in site/ calls with requests it built.
  readonly reply: (
    req: ReplyRequest,
    timedOut: () => boolean,
    accepted: number,
  ) => Promise<Reply>;
  readonly subscribe: FrameFeeds<CheckedRenderRequest>["subscribe"];
  // Re-read the config a render origin resolves to, now: what a durable click
  // does after it writes. The page in site/ calls it after it resets its
  // simulated machine's config file.
  readonly reloadConfig: (origin: RenderOrigin) => void;
  // What a daemon that won the socket starts: only it counts its memory or
  // watches its bundle.
  arm(): void;
  // [LAW:no-ambient-temporal-coupling] After this nothing launches, no timer
  // stays armed once what was in flight has settled, and only the log is
  // written. A read already under way may finish. Its value settles when the
  // launches and lifeline it ended have ended.
  close(): Promise<Settled>;
}

// [LAW:no-shared-mutable-globals] One daemon is live in a process at a time,
// because its paths and its log are read from the process's environment. What
// says so is the live daemon's closing signal, written only by `createDaemon`.
let liveDaemon: AbortSignal | null = null;

export function createDaemon(inputs: DaemonInputs): Daemon {
  // Before anything is built: a refused build hands back nothing to close.
  if (liveDaemon !== null && !liveDaemon.aborted) {
    throw new Error("a daemon is already live in this process");
  }
  const { bundle, memoryLimitBytes, registryUrl, clock, exit } = inputs;
  const instant = (): Instant => instantOf(clock.date());
  // [LAW:single-enforcer] What ends the daemon's work: every launch through its
  // launcher, and the lane edge's waits.
  const closing = new AbortController();
  // Whether the close has finished: what is logged after it is work that
  // outlived its daemon. A process exits with its close, so this is a daemon
  // closed in a process that goes on, and the next daemon's log can be the file
  // the line lands in: it says whose it is rather than reading as an event of
  // that daemon's.
  let closed = false;
  // [LAW:one-source-of-truth] What this daemon's work logs through.
  const log: DaemonLogger = (level, msg) =>
    dlog(level, closed ? `after close: ${msg}` : msg);
  // [LAW:one-source-of-truth] one cache instance per daemon process — multiple
  // instances would defeat the share-across-sessions invariant.
  const stats = new RuntimeStats();
  // [LAW:single-enforcer] Route all child_process spawns through src/proc/launch:
  // this daemon's launcher meters them into daemon-stats and ends them with it.
  // Its work holds this one, so a closed daemon's launches are refused here,
  // whichever daemon is live by then.
  const launcher = createLauncher({
    stats: stats.launchStats,
    signal: closing.signal,
    // [LAW:no-silent-failure] Each change in whether what the daemon launches
    // dies with it is said in daemon.log, and every feed redraws, so its warning
    // comes and goes on frames too.
    observeLifeline: (fault) => {
      log(
        fault === null ? "info" : "warn",
        fault === null
          ? "launch lifeline running again"
          : `launch lifeline ${fault}; the next launch starts another`,
      );
      frameFeeds.wakeWhere("data", () => true);
    },
  });
  // Before every owner that arms a timer: storage that cannot be read refuses
  // the build with nothing running.
  const storage = inputs.storage(log);
  const sessionState = new SessionState(storage.session);
  const settingsHistory = new SettingsHistory(
    sessionState,
    log,
    storage.history,
  );
  // Building starts nothing: only the daemon that won the socket arms them, so
  // the page answers the doctor's `serving` with no timer counting its memory.
  const limits = makeLimits(
    realLimitsDeps(
      stats.startedAt.getTime(),
      exit,
      { launcher, log },
      {
        limitBytes: memoryLimitBytes,
      },
    ),
  );
  const handlerProbes = new ProbeArrivals();
  const renderSightings = new RenderSightings();
  // [LAW:one-source-of-truth] The doctor's stores, under this daemon's state
  // directory: its click files them, and daemon-stats answers what they hold
  // to `cc-candybar doctor`.
  const doctorStores = fileStores(stateDir());
  // [LAW:single-enforcer] The daemon injects its log into both registries so
  // cache + watcher lifecycle events land in daemon.log at the right level.
  // Non-daemon consumers (var-system tests, future library use) take the
  // default debug-routed loggers and never write to daemon log files.
  const watcherRegistry = new WatcherRegistry({
    counters: stats,
    logger: log,
  });
  // [LAW:one-source-of-truth] One provider per data shape, shared across every
  // render in this daemon, built by the one constructor every renderer uses
  // (payload-providers.ts). The render cache owns DSL-state-per-config; these
  // serve the augmented payload that flows through every render.
  // [LAW:single-enforcer] The daemon's one record of every source's refreshes:
  // the providers', and each config's user sources (the render cache's).
  const refreshLedger = new RefreshLedger(log);
  // [LAW:one-source-of-truth] Whether the OS is delivering this daemon's file
  // events: one owner, started once the bind is won (`arm`).
  const fileEvents = new FileEventDelivery({
    watchers: watcherRegistry,
    logger: log,
  });
  const payloadProviders = createPayloadProviders({
    launcher,
    watchers: watcherRegistry,
    fileEvents,
    logger: log,
    ledger: refreshLedger,
  });
  const {
    gitProvider: gitService,
    usageStore,
    tmuxService,
    hostService,
    managedStorage,
  } = payloadProviders;
  const navigationHistory = new NavigationHistory();
  // Each session's effect memory — when its effect came into force — held in
  // daemon memory only: a restarted daemon starts every session's effect again.
  const effectSessions = new EffectSessions<RenderedLine>();
  // [LAW:single-enforcer] Each session's idle clock and the timer that closes
  // its menus (src/daemon/menu-idle.ts): a click restarts the clock, and the
  // close is the journaled write a ✕ makes.
  const menuIdle = new MenuIdle({
    now: instant,
    close: (sessionId, idle) => closeIdleMenus(sessionId, idle, verbCtx),
    failed: (sessionId, error) =>
      log(
        "error",
        `menu-idle: close failed (session=${sessionId}): ${inspect(error)}`,
      ),
  });
  // [LAW:single-enforcer] The one signer of every `run` link this daemon draws
  // and the one that verifies them on the click, over the state directory's key.
  const linkSigner = linkSignerFromKeyFile();
  // [LAW:no-ambient-temporal-coupling] The one owner of every `run` program in
  // flight (src/daemon/runs.ts), closed with the daemon.
  const runs = new Runs({
    supersede: (storage, sessionId) =>
      managedStorage.supersede(storage, sessionId),
    launch: launcher.launch,
    state: sessionState,
    log,
    now: instant,
  });
  // [LAW:single-enforcer] The one owner of what turning an animation lane on or
  // off takes (src/daemon/lane-setup.ts), told the switches each of a session's
  // clicks moved, and each request's arrival for the setups owed to it.
  const laneSetups = new LaneSetups({
    edge: productionLaneEdge(
      launcher,
      (sessionId) => frameFeeds.following(sessionId),
      closing.signal,
    ),
    // A bar pane runs this bundle under the node running it now, with the
    // flags it runs with (tsx's loader, under the test harness).
    host: {
      bundle: bundle.path,
      node: bundle.node,
      socket: socketPath(),
      preload: stableAttachPreload(bundle.path),
    },
    state: sessionState,
    log,
    now: instant,
    defer: (run) => void setImmediate(run),
  });
  // [LAW:single-enforcer] The one writer of the tmux status line lane's tmux
  // state (src/daemon/tmux-status.ts).
  const tmuxStatusLines: TmuxStatusLines = new TmuxStatusLines({
    edge: {
      run: (socket, args, stdin) =>
        runTmuxAsync(launcher, { socket }, "tmux-status", args, stdin),
      runSync: (socket, args, stdin) =>
        runTmux(launcher, { socket }, "tmux-status", args, stdin),
    },
    subscribe: (sessionId, sub) => frameFeeds.subscribe(sessionId, sub),
    sessionInPane: (socket, pane) =>
      frameFeeds.newestWhere(
        ({ hints: { tmux } }) =>
          tmux !== null &&
          tmux !== undefined &&
          tmux.socket === socket &&
          tmux.pane === pane,
      ),
    handler: [
      `CC_CANDYBAR_SOCKET=${shellWord(socketPath())}`,
      ...[...bundle.node, bundle.path].map(shellWord),
      "url-handle",
    ].join(" "),
    owner: socketPath(),
    log,
  });
  // Each subscribed session's frames, drawn from its latest render request
  // (candybar-animation-wbxz.jmm.usl). A change to the session's own state — a
  // click — brings its next frame forward.
  const frameFeeds: FrameFeeds<CheckedRenderRequest> = new FrameFeeds({
    render: (sessionId, fps, at) => renderFrame(parts, sessionId, fps, at),
    // [LAW:no-ambient-temporal-coupling] A wake only moves the feed's timer,
    // which fires in a later turn, so a click's whole run of writes and its
    // journal commit land before a frame of it is drawn.
    watch: (sessionId, onChange) =>
      reaction(() => sessionState.revision(sessionId), onChange),
    lanes: (sessionId) => viewLanes(parts, sessionId),
    // [LAW:single-enforcer] A feed's pin is its life: releasing it is the one
    // moment the feed stops drawing, so its drawn copies retire with it.
    pin: (sessionId) => {
      const unpin = renderCache.pin(sessionId);
      return () => {
        renderCache.stopDrawing(sessionId, "feed");
        unpin();
      };
    },
    shown: (req) => paneVisibility.shown(req.hints.tmux),
    watching: () => paneVisibility.follow(),
    refreshes: () => refreshLedger.totals(),
    periods: FEED_PERIODS,
    now: () => clock.monotonic(),
    instant,
    log,
  });
  // Which watched sessions' panes are on a screen, asked of their tmux servers
  // once a second while some feed exists: a session nobody can see is drawn at
  // the still rate however its bar moves, and one that comes into view is drawn
  // at once.
  const paneVisibility: PaneVisibility = new PaneVisibility({
    listPanes: (socket) =>
      runTmuxAsync(launcher, { socket }, "frames.visibility", [
        "list-panes",
        "-a",
        "-F",
        LIST_PANES_FORMAT,
      ]),
    listClients: (socket) =>
      runTmuxAsync(launcher, { socket }, "frames.visibility", [
        "list-clients",
        "-F",
        LIST_CLIENTS_FORMAT,
      ]),
    // The servers of the sessions someone is watching.
    sockets: () =>
      new Set(frameFeeds.watched().flatMap(({ req }) => tmuxServersOf(req))),
    onAnswer: (socket, status) => tmuxStatusLines.answered(socket, status),
    // Only the sessions on a server whose view changed are drawn again.
    onChange: (sockets) =>
      frameFeeds.wakeWhere("visibility", (req) =>
        tmuxServersOf(req).some((socket) => sockets.has(socket)),
      ),
    intervalMs: 1000,
    log,
  });
  // [LAW:one-source-of-truth] The tmux server a session's bar is on, as the
  // servers it is on: none outside tmux or from a client too old to say.
  function tmuxServersOf({
    hints: { tmux },
  }: CheckedRenderRequest): readonly string[] {
    return tmux === null || tmux === undefined ? [] : [tmux.socket];
  }
  // [LAW:single-enforcer] What each session's renderers could not honour, as
  // their frames recorded it (src/daemon/render-warnings.ts).
  const renderWarnings = new RenderWarningRecords();
  const renderCache = new RenderCache<SessionSource, CheckedRenderRequest>(
    {
      launcher,
      sessionState,
      watchers: watcherRegistry,
      log,
      storage: managedStorage,
      signer: linkSigner,
      ledger: refreshLedger,
      // [LAW:single-enforcer] The one delivery owner, whose OS stream a
      // `watch_file` source's watch rides.
      fileEvents,
      declare: (holds, facts, closure, sources) =>
        declareLanes(payloadProviders, holds, facts, closure, sources),
      // [LAW:single-enforcer] What every session's view draws from: its payload
      // derived over its declaration, its picks and its histories' depths.
      source: sessionSource({
        // [LAW:single-enforcer] Every provider logs the refreshes it makes,
        // through the one ledger, so a view's payload logs none of them.
        providers: payloadProviders,
        sessionState,
        history: (sessionId) => settingsHistory.depth(sessionId),
        // Measured against the gate of the config the view draws with.
        navigation: (sessionId, config) =>
          navigationHistory.depth(sessionId, sessionState, stateGate(config)),
      }),
    },
    {
      budgetBytes: () => renderCacheBudget(memoryLimitBytes),
      observers: {
        // [LAW:no-silent-failure] Every config (re)load's outcome lands in
        // daemon.log with its cause — the operator's only record of why a load
        // ran, and whether a save was picked up cleanly, kept rendering
        // last-known-good behind an error, or resolved to a different file.
        onReload: (entry, sessions, cause, settled) => {
          log("info", configLoadedLine(entry, cause, settled));
          // A reload changes the bar of every session drawn from the entry,
          // even one that failed and kept the old config: its indicator says so.
          for (const sessionId of sessions)
            frameFeeds.wake(sessionId, "reload");
        },
        // [LAW:single-enforcer] What a session's view draws from moved: its
        // feed's next frame is brought forward, whatever moved it: a request's
        // facts, a refresh landing after its deadline, a source publishing, a
        // pick. The dump link, which no view holds, wakes the same way.
        onViewChanged: (sessionId) => frameFeeds.wake(sessionId, "data"),
      },
    },
  );
  // [LAW:no-silent-failure] An edit made while file events went unheard is
  // re-read when they resume, in every entry, and every feed redraws when
  // delivery moves, so its row comes and goes on frames too.
  // [LAW:no-ambient-temporal-coupling] Every directory watch is judged against
  // the disk on the one period the daemon keeps time by: a folder replaced
  // beneath a renamed ancestor reports nothing to the handle bound to the old
  // one, and a directory the OS refused is heard again only by a retry.
  fileEvents.subscribe((notice) => {
    switch (notice.kind) {
      case "period":
        watcherRegistry.judge();
        return;
      case "caught-up":
        renderCache.reloadEvery({
          kind: "events-resumed",
          since: notice.since,
        });
        frameFeeds.wakeWhere("data", () => true);
        return;
      case "moved":
        frameFeeds.wakeWhere("data", () => true);
        return;
    }
  });
  // One cadence for "how often does the daemon look at its build on disk" —
  // the binary watch (exit on a changed bundle) and the update watch (does the
  // bundle match `src/`) both sample on it.
  const BIN_CHECK_INTERVAL_MS = 60 * 1000;
  // The registry is a network resource with releases hours apart; ask rarely.
  const RELEASE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

  const binaryWatch = makeBinaryWatch({
    targets: bundle.targets,
    intervalMs: BIN_CHECK_INTERVAL_MS,
    stat: fs.statSync,
    // The update notice's act rewrites the bundle, and a restart in the middle
    // would start the next daemon from a half-written one: a restart waits for
    // it. A success samples again at once; after a failure the next tick does.
    held: () => updateWatch.running(),
    exit: () => exit(0),
    log,
  });

  // [LAW:single-enforcer] The daemon is the process that observes the bundle
  // it runs (the binary watch restarts it on rebuild), so it is the one place
  // that knows whether something newer than that bundle exists — the source
  // beside it, or a published release — and the one owner of the notice's
  // clicks (src/daemon/update-notice.ts). The notice is a diagnostic channel of
  // its own, folded between the error and warning channels.
  const updateWatch = makeUpdateWatch({
    launcher,
    entryUrl: bundle.entryUrl,
    digest: bundle.digest,
    // [LAW:one-source-of-truth] Keyed by the bundle the act rewrites, the one
    // this daemon runs from.
    actsDir: actsDir(stateDir(), bundle.path),
    intervalMs: BIN_CHECK_INTERVAL_MS,
    releaseIntervalMs: RELEASE_CHECK_INTERVAL_MS,
    registryUrl,
    fetchImpl: fetch,
    onApplied: () => binaryWatch.checkNow(),
    log,
  });

  // [LAW:single-enforcer] The one queue every journal waits its turn in.
  const journalTurns = new JournalTurns({
    log,
    monotonic: () => clock.monotonic(),
  });
  const verbCtx = {
    sessionState,
    journalTurns,
    clickLanded: (sessionId: string) => menuIdle.clicked(sessionId, instant()),
    log,
    launcher,
    now: instant,
    applyUpdate: () => updateWatch.act(),
    // The load the session's bar is drawn from: its cache entry's load
    // outcome, and what the config that entry renders left unused.
    // [LAW:no-ambient-temporal-coupling] Reloaded first, as a save does: a
    // doctor click is a verdict on the files as they are now, not on
    // whether the fs watcher has caught up with an edit made a moment ago.
    doctor: productionEdge(launcher, (origin) => {
      const at = [origin.projectDir, origin.cwd, origin.target.path] as const;
      renderCache.reload(...at, { kind: "doctor" });
      const entry = renderCache.getOrCreate(...at);
      return {
        layers: entry.configLayers,
        error: entry.lastError,
        warning: entry.lastWarning,
        unused: entry.state.unused,
        config: entry.state.config,
      };
    }),
    doctorStores,
    probes: handlerProbes,
    clients: renderSightings,
    bundle: bundle.path,
    serving: () => limits.serving(),
    claudeInput: productionClaudeInputEdge(launcher),
    history: settingsHistory,
    navigation: navigationHistory,
    // The config a session's last render resolved from — the same entry the
    // render drew the bar with, so a save compares against the bar the user saw.
    configFor: (origin: RenderOrigin) =>
      renderCache.getOrCreate(origin.projectDir, origin.cwd, origin.target.path)
        .state.config,
    reloadConfig: (origin: RenderOrigin) =>
      renderCache.reload(origin.projectDir, origin.cwd, origin.target.path, {
        kind: "write",
      }),
    // The storage keys of the same entry `configFor` reads the config of.
    sourcesFor: (origin: RenderOrigin) =>
      renderCache.getOrCreate(origin.projectDir, origin.cwd, origin.target.path)
        .state.sources,
    links: linkSigner,
    runs,
    lanes: {
      of: (origin: RenderOrigin, sessionId: string) =>
        lanesAt(parts, origin, sessionId),
      clicked: (sessionId: string, before: LaneSwitches, after: LaneSwitches) =>
        laneClicked(parts, sessionId, before, after),
    },
    views: {
      follow: (sessionId: string, origin: RenderOrigin) =>
        renderCache.follow(
          sessionId,
          origin.projectDir,
          origin.cwd,
          origin.target.path,
        ),
    },
    diagnosticCopy: (sessionId: string, by: Drawing["by"], key: string) =>
      renderCache.drawnCopy(sessionId, by, key),
  };

  const parts: DaemonParts = {
    launcher,
    log,
    clock,
    bundle: bundle.path,
    sourceDigest: bundle.digest,
    doctorStores,
    stats,
    handlerProbes,
    renderSightings,
    watcherRegistry,
    refreshLedger,
    fileEvents,
    payloadProviders,
    sessionState,
    effectSessions,
    menuIdle,
    linkSigner,
    runs,
    laneSetups,
    tmuxStatusLines,
    frameFeeds,
    renderWarnings,
    renderCache,
    updateWatch,
    limits,
    verbCtx,
  };

  // [LAW:no-ambient-temporal-coupling] The last step of building, so a build
  // that throws leaves no live daemon behind it.
  liveDaemon = closing.signal;

  return {
    stats,
    launcher,
    log,
    memoryLimitBytes,
    clock,
    exit,
    // [LAW:single-enforcer] A closed daemon serves nothing, and this surface is
    // the way in. A click that got in holds or waits for a journal's turn, and
    // close ends those (src/daemon/journal-turns.ts); a subscribe its request
    // reached as the daemon closed is refused here and opens no feed.
    handle: async (req, timedOut, accepted) => {
      closing.signal.throwIfAborted();
      return handleRequest(parts, req, timedOut, accepted);
    },
    reply: async (req, timedOut, accepted) => {
      closing.signal.throwIfAborted();
      return replyTo(parts, req, timedOut, accepted);
    },
    subscribe: (sessionId, subscriber) => {
      closing.signal.throwIfAborted();
      return frameFeeds.subscribe(sessionId, subscriber);
    },
    reloadConfig: (origin) => {
      closing.signal.throwIfAborted();
      verbCtx.reloadConfig(origin);
    },
    arm() {
      closing.signal.throwIfAborted();
      fileEvents.start(watchProbeDir());
      binaryWatch.arm();
      updateWatch.arm();
      limits.arm();
    },
    close() {
      // [LAW:no-silent-failure][LAW:dataflow-not-control-flow] Every teardown step
      // runs, each in order, and one that throws is logged by name without
      // skipping the rest: the session state still flushes after a close failed.
      const teardown: ReadonlyArray<readonly [string, () => void]> = [
        // [LAW:no-ambient-temporal-coupling] Before the abort that wakes it,
        // the journal in flight commits what landed; none opens after.
        ["journalTurns close", () => journalTurns.close()],
        // [LAW:single-enforcer] Every tmux status line this daemon laid out is put
        // back before it goes (src/daemon/tmux-status.ts). It runs tmux, so it
        // comes before the abort that ends the daemon's launches.
        ["tmuxStatusLines restore", () => tmuxStatusLines.restoreAll()],
        // [LAW:no-ambient-temporal-coupling] Nothing launches from here on, what
        // is in flight is terminated, whichever owner's work it was, and the
        // launcher's lifeline goes.
        ["launches abort", () => closing.abort(new Error("the daemon closed"))],
        ["frameFeeds close", () => frameFeeds.close()],
        ["menuIdle dispose", () => menuIdle.dispose()],
        ["updateWatch close", () => updateWatch.close()],
        ["binaryWatch close", () => binaryWatch.close()],
        ["limits disarm", () => limits.disarm()],
        // Before the sources and the storage its states hold.
        ["renderCache close", () => renderCache.close()],
        ["gitService close", () => gitService.close()],
        ["usageStore close", () => usageStore.close()],
        ["tmuxService close", () => tmuxService.close()],
        ["hostService close", () => hostService.close()],
        ["runs close", () => runs.close()],
        ["managedStorage close", () => managedStorage.close()],
        ["fileEvents close", () => fileEvents.close()],
        ["watcherRegistry close", () => watcherRegistry.closeAll()],
        ["sessionState close", () => sessionState.close()],
      ];
      for (const [step, run] of teardown) {
        try {
          run();
        } catch (e) {
          log("warn", `${step} failed: ${(e as Error).message}`);
        }
      }
      closed = true;
      return launcher.settled();
    },
  };
}
