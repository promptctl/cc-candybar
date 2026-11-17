// The daemon as a value: what it holds, built from its inputs, and its one close.

import { Runs } from "./runs.js";
import { locations, type DaemonPaths } from "./paths";
import type { Host } from "../host";
import type { DaemonLog } from "./log";
import type { Inbound } from "./foundations/protocol";
import type { DaemonParts } from "./daemon-parts.js";
import {
  handleRequest,
  replyTo,
  type HandledRequest,
  type Reply,
  type ReplyRequest,
} from "./reply.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import type { SessionStorage } from "../renderer-interface/session-state";
import type { HistoryStorage } from "../renderer-interface/history-storage";
import type { LaunchOwner, Settled, TestableLauncher } from "../proc/launch";
import type { Launcher } from "../proc/launcher";
import type { DaemonLogger } from "../utils/logger";
import { actsDir } from "./update-act";
import type { Gates } from "./foundations/gates";
import { makeUpdateWatch } from "./update-notice";
import { newUpdateFact } from "./update-fact";
import type { ProcessProbe } from "./process-fingerprint";
import { makeBinaryWatch, type BundleStat } from "./binary-watch";
import { stableAttachPreload } from "../install/index.js";
import { type RenderOrigin } from "../config-hint";
import { createPayloadProviders } from "./payload-providers";
import { runTeardown, type TeardownStep } from "../utils/teardown";
import { FileEventDelivery } from "./cache/file-events";
import type { Timekeeper } from "../time";
import { LEVEL, type Acceptance } from "./foundations/request-event.js";
import { RefreshLedger } from "../utils/refresh-ledger";
import { SourceRuns } from "./source-runs";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
import { makeLimits, type LimitsDeps } from "./limits";
import type { DoctorMachineEdge, DoctorStores } from "../doctor/ports";
import { ProbeArrivals } from "../doctor/handler-probe";
import { RenderSightings } from "./render-sightings";
import { Collector } from "./collector.js";
import { FEED_PERIODS, FrameFeeds } from "./frame-feed.js";
import { type Lane } from "../config/lanes.js";
import {
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  PaneVisibility,
} from "./pane-visibility.js";
import { runTmuxAsync } from "../proc/tmux.js";
import { DeclaredStatusLines, TmuxStatusLines } from "./tmux-status.js";
import { shellWord } from "../shell-word.js";
import { typeInPane, type ClaudeInputEdge } from "../claude-input/typing.js";
import { clickLaunchVia } from "./foundations/click-launch.js";
import type { LaneEdge } from "./lane-setup.js";
import { Acts } from "./acts.js";
import { linkSignerOver } from "../click/link-signer.js";
import type { Asked } from "../utils/outcome.js";
import { instantAt, type Instant } from "../utils/instant.js";
import { parseFrame } from "../render/frame.js";
import { rendererHost } from "./renderer-host.js";
import { loadMainRenderer } from "../renderer/main.js";
import type { RendererPort } from "./renderer-process.js";
import type { AdapterToHost } from "../renderer-interface/adapter.js";
import { bootEnv } from "../renderer-interface/wire.js";
import {
  answeredBy,
  joinedEvent,
  type HeldEvent,
} from "../utils/event-hold.js";
import { located } from "./statusline-answer.js";
import { installFacts } from "../doctor/edge.js";
import { ClicksInFlight } from "./clicks-in-flight.js";
import { compareStructural, observable, runInAction } from "mobx";
import type { DaemonFacts } from "../facts/world-state.js";
import { fileEventsWarnings } from "./foundations/file-events-warnings.js";
import type { WatchId } from "../renderer-interface/adapter.js";
import type {
  Invalidation,
  WatcherHandle,
} from "./foundations/watch-targets.js";
import { closeByTurn, MenuIdle } from "./menu-idle.js";
import type { SessionId } from "./foundations/session-id.js";

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

// Where the session's picks and its settings history persist.
export interface DaemonStorage {
  readonly session: SessionStorage;
  readonly history: HistoryStorage;
}

// [LAW:effects-at-boundaries] Everything a daemon does to the machine, as an
// input: it names no real one itself, so a daemon is as isolated as the
// adapters it is handed. src/daemon/production-adapters.ts builds the real
// ones. An adapter that needs what `createDaemon` builds, as the launcher needs
// its stats and its closing signal, is a factory over those.
export interface DaemonAdapters {
  // The file the daemon's work logs to.
  readonly daemonLog: DaemonLog;
  // What every launch of the daemon's work goes through.
  readonly launcher: (own: LaunchOwner) => TestableLauncher;
  // Their files, for a daemon that won the socket, which makes it their sole
  // writer. Built over the daemon's log: a write in flight at the close finishes
  // after it, and what it logs says so like any other line of the daemon's work.
  readonly storage: (log: DaemonLogger) => DaemonStorage;
  // The doctor's stores, which this daemon files.
  readonly doctorStores: DoctorStores;
  // The doctor's reads of the machine.
  readonly doctorEdge: (launcher: Launcher, host: Host) => DoctorMachineEdge;
  readonly claudeInput: (launcher: Launcher) => ClaudeInputEdge;
  // What the daemon asks the machine about a pid: whether a process is there, and
  // when it started.
  readonly probe: (launcher: Launcher) => ProcessProbe;
  // What turning an animation lane on or off does to the machine: it is told
  // which lanes a session's feed follows, and ends its waits with the daemon.
  readonly laneEdge: (
    launcher: Launcher,
    following: (sessionId: SessionId) => ReadonlySet<Lane>,
    closing: AbortSignal,
    probe: ProcessProbe,
  ) => LaneEdge;
  // [LAW:one-source-of-truth] The link key, asked for at each use: every
  // click is opened with it and every renderer draws with it.
  readonly linkKey: () => Asked<Buffer>;
  // What the memory backstop reads and writes on the machine.
  readonly limits: (own: {
    readonly startedAtMs: number;
    readonly exit: (code: number) => void;
    readonly launcher: Launcher;
    readonly log: DaemonLogger;
  }) => LimitsDeps;
  // [LAW:one-type-per-behavior] Where the renderer runs: in this process, or
  // in a process of its own (src/daemon/renderer-process.ts).
  readonly renderer: RendererPort;
  // The registry the update notice asks which release is newest.
  readonly fetch: typeof fetch;
  // How the binary watch reads the bundle's mtime.
  readonly stat: BundleStat;
}

// What a daemon takes from the process that runs it: where its files are, what
// it does to the machine, and the numbers it runs by.
export interface DaemonInputs extends DaemonAdapters {
  readonly bundle: RunningBundle;
  // [LAW:one-source-of-truth] What the process knows of its machine: its
  // environment, home and temporary directory. The daemon reads them from here
  // alone, and its launcher's children inherit the same environment.
  readonly host: Host;
  // The paths the daemon itself reads or writes. The files an adapter owns are
  // aimed by the same value at the adapter (production-adapters.ts), so a daemon
  // aimed at a temporary directory writes nowhere else.
  readonly paths: Pick<DaemonPaths, "socket" | "state" | "watchProbe">;
  readonly memoryLimitBytes: number;
  readonly registryUrl: string;
  // [LAW:effects-at-boundaries] The daemon's clock: what it draws and times
  // requests by, and every timer its pieces set. A test holds it by hand.
  // [LAW:one-source-of-truth] `after` runs a request's wait and its backstop on
  // the same clock its budget is figured from, so a held clock holds all three.
  readonly clock: Timekeeper;
  // [LAW:no-shared-mutable-globals] What this daemon's loads accept: its own
  // value, built by the root with `daemonGates` (the update notice's links need
  // the keys it holds), so two daemons in one process share none.
  readonly gates: Gates;
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
  readonly clock: Timekeeper;
  // [LAW:one-source-of-truth] The funnel this daemon was built with, which a
  // connection reaches once a reply carrying an exit has flushed.
  readonly exit: DaemonInputs["exit"];
  // The request handling a connection calls, with the request as its
  // connection accepted it.
  readonly handle: (
    inbound: Inbound,
    timedOut: () => boolean,
    accepted: Acceptance,
    clientLeft: () => boolean,
  ) => Promise<HandledRequest>;
  // The reply to a request of any kind but a subscribe, past the connection's
  // checkpoint: what the page in site/ calls with requests it built.
  readonly reply: (
    req: ReplyRequest,
    timedOut: () => boolean,
    accepted: Acceptance,
    clientLeft: () => boolean,
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
  // written. A read already under way may finish. It resolves once every
  // teardown step has run, the renderer's included, and its `settled` once the
  // launches and lifeline it ended have ended.
  close(): Promise<{ readonly settled: Promise<Settled> }>;
}

export function createDaemon(inputs: DaemonInputs): Daemon {
  const {
    bundle,
    memoryLimitBytes,
    registryUrl,
    clock,
    exit,
    paths,
    gates,
    host,
  } = inputs;
  // Parsed once, here, and handed to everything that loads a config.
  const locs = locations(host);
  const instant = (): Instant => instantAt(clock);
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
    inputs.daemonLog.log(level, closed ? `after close: ${msg}` : msg);
  // [LAW:one-source-of-truth] one cache instance per daemon process — multiple
  // instances would defeat the share-across-sessions invariant.
  const stats = new RuntimeStats(clock);
  // [LAW:single-enforcer] The daemon injects its log into both registries so
  // cache + watcher lifecycle events land in daemon.log at the right level.
  // Non-daemon consumers (var-system tests, future library use) take the
  // default debug-routed loggers and never write to daemon log files.
  const watcherRegistry = new WatcherRegistry({
    clock,
    counters: stats,
    logger: log,
  });
  // [LAW:one-source-of-truth] Whether the OS is delivering this daemon's file
  // events: one owner, started once the bind is won (`arm`).
  const fileEvents = new FileEventDelivery({
    watchers: watcherRegistry,
    logger: log,
    clock,
  });
  // [LAW:one-source-of-truth] The daemon's own faults, as every session's
  // world state carries them: whether file events are heard, and what the
  // launcher stands behind. Restated whenever either may have moved, and
  // compared whole, so a restatement that moved nothing moves no document.
  // [LAW:no-ambient-temporal-coupling] Declared before the launcher, whose
  // observer restates them.
  const daemonFaults = observable.box<
    Pick<DaemonFacts, "fileEvents" | "launcher" | "rendererEnded" | "actFailed">
  >(
    { fileEvents: [], launcher: [], rendererEnded: null, actFailed: null },
    { deep: false, equals: compareStructural },
  );
  // [LAW:one-source-of-truth] How the last renderer process ended, and the
  // acts that failed with no session's bar to hold them, each held for the
  // bar until an answer has carried it.
  let rendererEnded: HeldEvent | null = null;
  let actFailed: HeldEvent | null = null;
  function restateFaults(): void {
    runInAction(() =>
      daemonFaults.set({
        fileEvents: fileEventsWarnings(fileEvents.delivery()),
        launcher: launcher.standing(),
        rendererEnded,
        actFailed,
      }),
    );
  }
  // [LAW:single-enforcer] Route all child_process spawns through src/proc/launch:
  // this daemon's launcher meters them into daemon-stats and ends them with it.
  // Its work holds this one, so a closed daemon's launches are refused here,
  // whichever daemon is live by then.
  const launcher = inputs.launcher({
    inherited: host.env,
    stats: stats.launchStats,
    signal: closing.signal,
    // [LAW:one-source-of-truth] Pipe events are stamped on the clock renders
    // hold them against.
    now: instant,
    // [LAW:no-silent-failure] Each change in whether what the daemon launches
    // dies with it, and each pipe event, is said in daemon.log, and every
    // session's world state carries it, so its warning comes on frames too.
    observeWarnings: (change) => {
      if (change.kind === "launch-pipes") log("warn", change.text);
      else
        log(
          change.fault === null ? "info" : "warn",
          change.fault === null
            ? "launch lifeline running again"
            : `launch lifeline ${change.fault}; the next launch starts another`,
        );
      restateFaults();
    },
  });
  // [LAW:one-source-of-truth] The update watch and the lane edge read a pid
  // through this one probe, so a probe handed in reaches both. The process entry
  // (server.ts) asks its own before this daemon exists.
  const probe = inputs.probe(launcher);
  const linkSigner = linkSignerOver(inputs.linkKey);
  // Before every owner that arms a timer: a renderer in process loads here, so
  // storage it cannot read refuses the build with nothing running. One in a
  // process of its own loads there, and refuses its boot with the reason on
  // the bar's ⚠.
  const preparedRenderer = inputs.renderer({
    load: () =>
      loadMainRenderer({
        clock,
        now: instant,
        storage: { ...inputs.storage(log), doctor: inputs.doctorStores },
        linkSigner,
        stateDir: paths.state,
        locations: locs,
        env: host.env,
        home: host.home,
        gates,
        bundle: bundle.path,
        memoryLimitBytes,
      }),
    // The key crosses in base64, so the boot crosses as a line.
    boot: () => {
      const key = inputs.linkKey();
      return {
        digest: bundle.digest,
        host: { ...host, env: bootEnv(host.env) },
        bundle: bundle.path,
        memoryLimitBytes,
        linkKey:
          key.kind === "ok"
            ? { kind: "ok", value: key.value.toString("base64") }
            : key,
      };
    },
    node: bundle.node,
  });
  // Building starts nothing: only the daemon that won the socket arms them, so
  // the page answers the doctor's `serving` with no timer counting its memory.
  const limits = makeLimits({
    ...inputs.limits({
      startedAtMs: stats.startedAt.getTime(),
      exit,
      launcher,
      log,
    }),
    limitBytes: memoryLimitBytes,
    // [LAW:one-source-of-truth] The limit is over the daemon's whole: the
    // renderer's process counts in it while one runs. Read only once armed,
    // by when the link below exists.
    renderer: () => link.process(),
  });
  const handlerProbes = new ProbeArrivals();
  const renderSightings = new RenderSightings();
  // [LAW:one-source-of-truth] The doctor's stores, under this daemon's state
  // directory: its click files them, and daemon-stats answers what they hold
  // to `cc-candybar doctor`.
  const doctorStores = inputs.doctorStores;
  // [LAW:one-source-of-truth] One provider per data shape, shared across every
  // render in this daemon, built by the one constructor every renderer uses
  // (payload-providers.ts). The render cache owns DSL-state-per-config; these
  // serve the augmented payload that flows through every render.
  // [LAW:single-enforcer] The daemon's one record of every source's refreshes:
  // the providers', and each config's user sources (the render cache's).
  const refreshLedger = new RefreshLedger(log);
  restateFaults();
  // [LAW:single-enforcer] The daemon's one owner of every declared source's
  // runs: the collector holds each run a session's renderer subscribes to, so
  // one identity is one program however many sessions name it.
  const sourceRuns = new SourceRuns({
    launcher,
    clock,
    logger: log,
    ledger: refreshLedger,
    watchers: watcherRegistry,
    fileEvents,
  });
  const payloadProviders = createPayloadProviders({
    launcher,
    host,
    watchers: watcherRegistry,
    fileEvents,
    clock,
    logger: log,
    ledger: refreshLedger,
    sourceRuns,
  });
  const { managedStorage } = payloadProviders;
  // [LAW:single-enforcer] Each session's idle clock and the timer that closes
  // its menus (src/daemon/menu-idle.ts): a click restarts the clock, and the
  // close is a `menu-idle` turn of the renderer, the journaled write a ✕ makes,
  // through the host's one path to it, which the parts below hold: no close is
  // due before a frame has drawn a menu, so the parts exist by then.
  const menuIdle = new MenuIdle({
    clock,
    now: instant,
    close: (sessionId, idle) =>
      closeByTurn(
        parts.renderer,
        instant,
        sessionId,
        idle,
        frameFeeds.latest(sessionId),
      ),
    failed: (sessionId, failure) =>
      log(
        LEVEL[failure.kind],
        `menu-idle: close failed (session=${sessionId}): ${failure.detail}`,
      ),
  });
  // [LAW:no-ambient-temporal-coupling] The one owner of every `run` program in
  // flight (src/daemon/runs.ts), closed with the daemon.
  const runs = new Runs({
    supersede: (folder, sessionId) =>
      managedStorage.supersede(folder, sessionId),
    launch: launcher.launch,
    clock,
  });
  // [LAW:single-enforcer] The host's one performer of the acts the renderer's
  // turns return (src/daemon/acts.ts).
  const acts = new Acts({
    launch: clickLaunchVia(launcher),
    type: typeInPane(inputs.claudeInput(launcher)),
    run: (run) => runs.start(run),
    applyUpdate: () => updateWatch.act(),
    lanes: {
      edge: inputs.laneEdge(
        launcher,
        (sessionId) => frameFeeds.following(sessionId),
        closing.signal,
        probe,
      ),
      // A bar pane runs this bundle under the node running it now, with the
      // flags it runs with (tsx's loader, under the test harness).
      host: {
        bundle: bundle.path,
        node: bundle.node,
        socket: paths.socket,
        preload: stableAttachPreload(bundle.path, host),
      },
    },
    closing: () => closing.signal.aborted,
    log,
  });
  // [LAW:single-enforcer] The one writer of the tmux status line lane's tmux
  // state (src/daemon/tmux-status.ts).
  const tmuxStatusLines: TmuxStatusLines = new TmuxStatusLines({
    edge: {
      run: (socket, args, stdin) =>
        runTmuxAsync(launcher, { socket }, "tmux-status", args, stdin),
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
      `CC_CANDYBAR_SOCKET=${shellWord(paths.socket)}`,
      ...[...bundle.node, bundle.path].map(shellWord),
      "url-handle",
    ].join(" "),
    owner: paths.socket,
    log,
  });
  // Each subscribed session's frames, drawn from its latest render request
  // (candybar-animation-wbxz.jmm.usl). A change to the session's own state — a
  // click — brings its next frame forward.
  // [LAW:single-enforcer] The rows the renderer declares on, followed to each
  // session's newest pane.
  const declaredStatusLines = new DeclaredStatusLines(
    tmuxStatusLines,
    (sessionId) => frameFeeds.latest(sessionId)?.hints.tmux,
  );
  const frameFeeds: FrameFeeds<CheckedRenderRequest> = new FrameFeeds({
    frame: async (sessionId, fps, at, following, feeds) => {
      const { frame } = await parts.renderer.ask(
        {
          kind: "frame",
          session: sessionId,
          fps,
          following,
          feeds,
          idleSince: menuIdle.since(sessionId, at) ?? null,
        },
        at,
      );
      // [LAW:parse-dont-validate] The receiving edge of a feed frame.
      return frame === null ? null : { ...frame, bar: parseFrame(frame.bar) };
    },
    lanes: async (sessionId) =>
      (
        await parts.renderer.ask(
          { kind: "lanes", session: sessionId },
          instant(),
        )
      ).lanes,
    // [LAW:no-ambient-temporal-coupling] The pin's wake of the session's
    // state only moves the feed's timer, which fires in a later turn. A click
    // that awaits gives up the loop, so a frame may show its writes ahead of
    // its commit; the step stays whole.
    pin: (sessionId) =>
      parts.renderer.tell({ kind: "pin", session: sessionId }, instant()),
    unpin: (sessionId) =>
      parts.renderer.tell({ kind: "unpin", session: sessionId }, instant()),
    shown: (req) => paneVisibility.shown(req.hints.tmux),
    watching: () => paneVisibility.follow(),
    refreshes: () => refreshLedger.totals(),
    periods: FEED_PERIODS,
    clock,
    instant,
    log,
  });
  // Which watched sessions' panes are on a screen, asked of their tmux servers
  // once a second while some feed exists: a session nobody can see is drawn at
  // the still rate however its bar moves, and one that comes into view is drawn
  // at once.
  const paneVisibility: PaneVisibility = new PaneVisibility({
    clock,
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
  // [LAW:one-source-of-truth] The daemon's one update fact: the update watch
  // writes it and every session's facts document reads it, so the box exists
  // before either.
  const updateFact = newUpdateFact();
  // [LAW:no-silent-failure] An edit made while file events went unheard is
  // re-read when they resume, in every entry, one entry per turn, each
  // waking its own sessions as its reload lands. Every feed redraws when
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
        restateFaults();
        parts.renderer.tell(
          { kind: "reload-every", since: notice.since },
          instant(),
        );
        return;
      case "moved":
        restateFaults();
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
    clock,
    targets: bundle.targets,
    intervalMs: BIN_CHECK_INTERVAL_MS,
    stat: inputs.stat,
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
    fact: updateFact,
    clock,
    launcher,
    probe,
    entryUrl: bundle.entryUrl,
    digest: bundle.digest,
    // [LAW:one-source-of-truth] Keyed by the bundle the act rewrites, the one
    // this daemon runs from.
    actsDir: actsDir(paths.state, bundle.path),
    intervalMs: BIN_CHECK_INTERVAL_MS,
    releaseIntervalMs: RELEASE_CHECK_INTERVAL_MS,
    registryUrl,
    fetchImpl: inputs.fetch,
    onApplied: () => binaryWatch.checkNow(),
    log,
  });

  // [LAW:single-enforcer] The host's one reader of every session's world. What
  // it hands in alone goes through the host's one path to the renderer, which
  // the parts below hold; a delivery is first asked for by an owner landing
  // after a request, so the parts exist by then.
  const collector = new Collector({
    owners: payloadProviders,
    daemon: () => ({
      update: { newer: updateFact.get(), ...updateWatch.acts() },
      ...daemonFaults.get(),
    }),
    clock,
    watched: (sessionId) => frameFeeds.feedOpen(sessionId),
    deliver: (event) =>
      parts.renderer.deliver({ kind: "event", event, at: instant() }, []),
    log,
  });

  const clicks = new ClicksInFlight();
  // [LAW:single-enforcer] Each watch the renderer holds, by the id it minted,
  // from its `watch` to its `unwatch`.
  const rendererWatches = new Map<WatchId, WatcherHandle>();
  const doctorEdge = inputs.doctorEdge(launcher, host);
  // [LAW:one-way-deps] The host's parts the main renderer reaches: the
  // compiler checks each against its entry in `AdapterToHost` here, so no
  // renderer file names a host type.
  const reaches: AdapterToHost = {
    // [LAW:effects-at-boundaries] exception: each reach below that crosses is
    // the host's part in its crossing shape: a notice, or an awaited call.
    wake: (sessionId, cause) => frameFeeds.wake(sessionId, cause),
    log,
    doctor: {
      ...doctorEdge,
      install: async (daemonBundle, clients) =>
        installFacts(doctorEdge.install, daemonBundle, clients),
    },
    menuIdle: {
      clicked: (sessionId, at) => menuIdle.clicked(sessionId, at),
      clickArrived: (sessionId) => menuIdle.clickArrived(sessionId),
      clickSettled: (sessionId) => menuIdle.clickSettled(sessionId),
      observe: (sessionId, at, shown, timeoutS) =>
        menuIdle.observe(sessionId, at, shown, timeoutS),
      confirmClose: async (sessionId, firedAt) =>
        menuIdle.confirmClose(sessionId, firedAt),
    },
    clicks: { gone: async (click) => clicks.gone(click) },
    serving: async () => limits.serving(),
    renderSightings: {
      ofSession: async (sessionId, now) =>
        renderSightings.ofSession(sessionId, now),
    },
    eventAnswered: (event) => {
      launcher.answeredPipeEvent(event);
      if (rendererEnded !== null && answeredBy(rendererEnded, event))
        rendererEnded = { ...rendererEnded, answered: true };
      if (actFailed !== null && answeredBy(actFailed, event))
        actFailed = { ...actFailed, answered: true };
      restateFaults();
    },
    watches: {
      watch: (id, key, targets) => {
        // Each window the registry hears goes back to the renderer with
        // the watch's deafness as it stands then.
        const told = (heard: Invalidation | null): void =>
          parts.renderer.tell(
            { kind: "watch", id, heard, deaf: handle.deaf },
            instant(),
          );
        const handle = watcherRegistry.acquire(key, targets, told);
        rendererWatches.set(id, handle);
        // [LAW:no-ambient-temporal-coupling] The acquire's own push goes
        // after the notice that asked for it, as it would from another
        // process: a renderer's start acquires watches before the host holds
        // the renderer it builds.
        void clock.defer(() => {
          if (rendererWatches.get(id) === handle) told(null);
        });
      },
      unwatch: (id) => {
        rendererWatches.get(id)?.release();
        rendererWatches.delete(id);
      },
    },
    storage: {
      hold: (id, folders) => managedStorage.hold(id, folders),
      release: (id) => managedStorage.release(id),
    },
  };
  const link = preparedRenderer.start({
    reaches,
    log,
    clock,
    // [LAW:single-enforcer] A renderer that starts again is configured as a
    // request would: every live session whose newest request the host holds
    // gets its config with its latest stamp, all in the one `start` turn, so
    // its output names every session it serves; and every open feed gets its
    // `pin`. All through the host's one path to the renderer, each turn
    // recorded there.
    start: async () => {
      const at = instant();
      for (const sessionId of frameFeeds.openFeeds())
        parts.renderer.tell({ kind: "pin", session: sessionId }, at);
      const sessions = [...collector.liveDocuments()].flatMap(
        ([sessionId, worldState]) => {
          const req = frameFeeds.latest(sessionId);
          return req === null ? [] : [{ context: located(req), worldState }];
        },
      );
      await parts.renderer.deliver(
        { kind: "event", at, event: { kind: "start", sessions } },
        [["why", "renderer-start"]],
      );
    },
    ended: (event) => {
      rendererEnded = event;
      restateFaults();
    },
  });
  const parts: DaemonParts = {
    clicks,
    home: host.home,
    tmp: host.tmp,
    launcher,
    log,
    clock,
    bundle: bundle.path,
    sourceDigest: bundle.digest,
    doctorStores,
    stats,
    handlerProbes,
    linkSigner,
    renderSightings,
    watcherRegistry,
    refreshLedger,
    fileEvents,
    payloadProviders,
    menuIdle,
    runs,
    sourceRuns,
    tmuxStatusLines,
    declaredStatusLines,
    frameFeeds,
    updateWatch,
    limits,
    collector,
    renderer: rendererHost(
      "main",
      clock,
      link.renderer,
      log,
      {
        subscribed: (subscriptions) => {
          collector.subscribed(subscriptions);
          declaredStatusLines.declare(subscriptions.tmuxStatus);
        },
        holding: (session) => collector.holding(session),
      },
      {
        perform: (act) => acts.perform(act),
        stateDir: paths.state,
        closing: () => closing.signal.aborted,
        // [LAW:no-silent-failure] Joined to the last while it is owed, by the
        // one rule for events that follow each other.
        unheard: (text) => {
          actFailed = joinedEvent(actFailed, text, instant());
          restateFaults();
        },
      },
    ),
  };

  return {
    stats,
    launcher,
    log,
    memoryLimitBytes,
    clock,
    exit,
    // [LAW:single-enforcer] A closed daemon serves nothing, and this surface is
    // the way in. A click that got in is gathering, or holds or waits for a journal's turn,
    // and close ends those (src/renderer/journal-turns.ts); a subscribe its request
    // reached as the daemon closed is refused here and opens no feed.
    handle: async (req, timedOut, accepted, clientLeft) => {
      closing.signal.throwIfAborted();
      return handleRequest(parts, req, timedOut, accepted, clientLeft);
    },
    reply: async (req, timedOut, accepted, clientLeft) => {
      closing.signal.throwIfAborted();
      return replyTo(parts, req, timedOut, accepted, clientLeft);
    },
    subscribe: (sessionId, subscriber) => {
      closing.signal.throwIfAborted();
      return frameFeeds.subscribe(sessionId, subscriber);
    },
    reloadConfig: (origin) => {
      closing.signal.throwIfAborted();
      parts.renderer.tell({ kind: "reload-config", origin }, instant());
    },
    arm() {
      closing.signal.throwIfAborted();
      fileEvents.start(paths.watchProbe);
      binaryWatch.arm();
      updateWatch.arm();
      limits.arm();
      link.arm();
    },
    async close() {
      // The renderer's three steps of the teardown, each awaited where it
      // stands: the renderer takes them in the order they are sent.
      const rendererStep =
        (kind: "close-journal" | "close-views" | "close-session-state") =>
        (): Promise<unknown> =>
          parts.renderer.ask({ kind }, instant());
      // The session state still flushes after a close failed (runTeardown).
      const teardown: readonly TeardownStep[] = [
        // [LAW:no-ambient-temporal-coupling] First: from here a renderer that
        // ends is not started again, so no step below waits on a fresh boot.
        ["renderer close begins", () => link.beginClose()],
        // [LAW:single-enforcer] Every tmux status line this daemon laid out is put
        // back before it goes (src/daemon/tmux-status.ts).
        // [LAW:no-ambient-temporal-coupling] Before any of the renderer's turns:
        // one waits behind whatever turn the renderer is in, which can outlast
        // shutdown's backstop, while this waits only on its own tmux calls.
        ["tmuxStatusLines close", () => tmuxStatusLines.close()],
        // [LAW:no-ambient-temporal-coupling] Before the abort that wakes the
        // journal in flight, so none opens after.
        ["journalTurns close", rendererStep("close-journal")],
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
        ["collector close", () => collector.close()],
        ["renderer views close", rendererStep("close-views")],
        ...payloadProviders.closes,
        ["runs close", () => runs.close()],
        // After the collector, which holds every session's runs: its close
        // releases them first, so this close drops nothing still held.
        ["sourceRuns close", () => sourceRuns.close()],
        ["fileEvents close", () => fileEvents.close()],
        ["watcherRegistry close", () => watcherRegistry.closeAll()],
        // Last: a run that ends in the teardown holds its click error first.
        ["sessionState close", rendererStep("close-session-state")],
        // After every step the renderer takes: its process, when it has one,
        // ends with nothing left to flush.
        ["renderer process close", () => link.close()],
      ];
      await runTeardown(teardown, log);
      closed = true;
      return { settled: launcher.settled() };
    },
  };
}
