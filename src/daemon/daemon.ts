// The daemon as a value: what it holds, built from its inputs, and its one close.

import { Runs } from "./runs.js";
import { cacheDir, daemonPaths, homeEnv, locations } from "./paths";
import type { RendererHome } from "./home";
import type { Host } from "../host";
import type { DaemonLog } from "./log";
import type { Inbound } from "./protocol";
import type { DaemonParts } from "./daemon-parts.js";
import {
  drawAnswer,
  lanesAt,
  laneClicked,
  laneSessionOf,
  requestArrived,
  renderFrame,
  viewLanes,
} from "./draw-bar.js";
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
import type {
  LaunchOwner,
  Launcher,
  Settled,
  TestableLauncher,
  WarningChange,
} from "../proc/launch";
import type { DaemonLogger } from "../utils/logger";
import { actsDir } from "./update-act";
import type { Gates } from "./foundations/gates";
import { makeUpdateWatch, type UpdateWatch } from "./update-notice";
import { newUpdateFact, type UpdateFact } from "./update-fact";
import type { ProcessProbe } from "./process-fingerprint";
import { makeBinaryWatch, type BinaryWatch } from "./binary-watch";
import type { Filesystem, FilesystemReads } from "../disk/filesystem";
import { stableAttachPreload } from "../install/index.js";
import { type RenderOrigin } from "../config-hint";
import {
  createPayloadProviders,
  type PayloadProviders,
} from "./payload-providers";
import { FileEventDelivery } from "./cache/file-events";
import type { Monotonic, Timekeeper } from "../time";
import type { Pricing } from "../segments/pricing";
import { RefreshLedger } from "../utils/refresh-ledger";
import { SourceRuns } from "../var-system/source-runs";
import {
  configLoadedLine,
  RenderCache,
  renderCacheBudget,
  type RenderDeps,
  type SourceOf,
} from "./cache/render";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
import { makeLimits, type LimitsDeps } from "./limits";
import { SessionState } from "./session-state";
import { SettingsHistory } from "./settings-history";
import { NavigationHistory } from "./navigation-history";
import { apply, sayUnapplied } from "./apply.js";
import type { DoctorEdge, DoctorStores } from "../doctor/edge";
import { ProbeArrivals } from "../doctor/handler-probe";
import { RenderSightings } from "./render-sightings";
import { inProcessFacts } from "./facts-source.js";
import { recordedCache, type SessionRecorder } from "./session-recorder.js";
import {
  sessionSource,
  type SessionSource,
  type SessionSourceDeps,
} from "./session-source.js";
import { EffectSessions } from "../render/effect.js";
import { FEED_PERIODS, FrameFeeds, type FeedDeps } from "./frame-feed.js";
import { laneEncoders } from "./lane-frames.js";
import { linkIdAllocator, type LinkIdAllocator } from "./link-id-allocator.js";
import { type Lane } from "../config/lanes.js";
import {
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  PaneVisibility,
} from "./pane-visibility.js";
import { runTmuxAsync } from "../proc/tmux.js";
import type { TmuxAtExit } from "./tmux-status.js";
import { TmuxStatusLines } from "./tmux-status.js";
import { shellWord } from "../shell-word.js";
import { reaction } from "mobx";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { ClaudeInputEdge } from "../claude-input/edge.js";
import { LaneSetups, type LaneEdge, type LaneHost } from "./lane-setup.js";
import type { LinkSigner } from "../click/link-signer.js";
import type { RendererLinks } from "../click/renderer-links.js";
import { RenderWarningRecords } from "./render-warnings.js";
import { instantOf, type Instant } from "../utils/instant.js";
import { JournalTurns } from "./journal-turns.js";
import { MenuIdle } from "./menu-idle.js";
import { MismatchRuns } from "./mismatch-runs.js";
import { runsNowIn, type HeldSessionOf } from "./session-pane.js";
import type { GitEnvAsk } from "../git-env.js";

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
  // [LAW:one-source-of-truth] Over the daemon's own disk, so the undo journal
  // is kept on the disk whose config files it puts back.
  readonly storage: (log: DaemonLogger, disk: Filesystem) => DaemonStorage;
  // The doctor's stores, which this daemon files.
  // [LAW:one-source-of-truth] Over the daemon's own disk (`filesystem`), the
  // one its storage writes, so the doctor's files land beside the daemon's.
  readonly doctorStores: (disk: Filesystem) => DoctorStores;
  // The doctor's reads of the machine, over the config load it is handed.
  readonly doctorEdge: (
    launcher: Launcher,
    loadConfig: DoctorEdge["loadConfig"],
    host: Host,
    // [LAW:types-are-the-program] Reads only: the doctor's edge never writes.
    disk: FilesystemReads,
  ) => DoctorEdge;
  readonly claudeInput: (launcher: Launcher) => ClaudeInputEdge;
  // What the daemon asks the machine about a pid: whether a process is there, and
  // when it started.
  readonly probe: (launcher: Launcher) => ProcessProbe;
  // What turning an animation lane on or off does to the machine: it is told
  // which lanes a session's feed follows, and ends its waits with the daemon.
  readonly laneEdge: (
    launcher: Launcher,
    following: (sessionId: string) => ReadonlySet<Lane>,
    closing: AbortSignal,
    probe: ProcessProbe,
    heldSession: HeldSessionOf,
    // [LAW:types-are-the-program] Reads only: the lane edge never writes to
    // the disk; its effects go to tmux panes and Claude Code.
    disk: FilesystemReads,
    // [LAW:one-source-of-truth] The daemon's one claude-input edge, so a lane
    // types into Claude Code through the edge a click does.
    claudeInput: ClaudeInputEdge,
  ) => LaneEdge;
  // The session a Claude Code process holds, by the records Claude Code keeps
  // under the user's home (`home`) or the directory a session names.
  readonly heldSession: (home: string) => HeldSessionOf;
  // The one signer of every `run` link this daemon draws.
  readonly linkSigner: LinkSigner;
  // What the memory backstop reads and writes on the machine.
  readonly limits: (own: {
    readonly startedAtMs: number;
    readonly exit: (code: number) => void;
    readonly launcher: Launcher;
    readonly log: DaemonLogger;
  }) => LimitsDeps;
  // The registry the update notice asks which release is newest.
  readonly fetch: typeof fetch;
  // What prices a transcript entry that carries no cost, over the home's cache
  // directory. It ends with the daemon's closing signal, so no step of the
  // close has to remember it.
  readonly pricing: (own: {
    readonly cacheRoot: string;
    readonly closing: AbortSignal;
    readonly log: DaemonLogger;
  }) => Pricing;
  // The disk the daemon's watches open on and the binary watch stats.
  readonly filesystem: Filesystem;
}

// What a daemon takes from the process that runs it: where its files are, what
// it does to the machine, and the numbers it runs by.
export interface DaemonInputs extends DaemonAdapters {
  readonly bundle: RunningBundle;
  // [LAW:one-source-of-truth] What the process knows of its machine: its
  // environment, home and temporary directory. The daemon reads them from here
  // alone, and its launcher's children inherit the same environment.
  readonly host: Host;
  // [LAW:one-source-of-truth] The daemon's identity: every path it reads or
  // writes derives from this (paths.ts). The files an adapter owns are aimed by
  // the same home at the adapter (production-adapters.ts), so a daemon under a
  // home writes nowhere else.
  readonly home: RendererHome;
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
  // What git named, at the process's start, as the variables that locate a
  // repository, which `host.env` is already without (src/host.ts
  // daemonWorld): an ask that failed is on every bar this daemon draws.
  readonly gitEnv: GitEnvAsk;
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
  // The request handling a connection calls. `accepted` is when its connection
  // came in, on `clock`'s monotonic reading.
  readonly handle: (
    inbound: Inbound,
    timedOut: () => boolean,
    accepted: Monotonic,
    clientLeft: () => boolean,
  ) => Promise<HandledRequest>;
  // The reply to a request of any kind but a subscribe, past the connection's
  // checkpoint: what the page in site/ calls with requests it built.
  readonly reply: (
    req: ReplyRequest,
    timedOut: () => boolean,
    accepted: Monotonic,
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
  // written. A read already under way may finish. Its value settles when the
  // launches and lifeline it ended have ended. `atExit` is what puts the tmux
  // status lines back: synchronous, because shutdown is.
  close(atExit: TmuxAtExit): Promise<Settled>;
}

export function createDaemon(inputs: DaemonInputs): Daemon {
  const {
    bundle,
    memoryLimitBytes,
    registryUrl,
    clock,
    exit,
    home,
    gates,
    host,
    gitEnv,
  } = inputs;
  // Derived once, here, from the one home, and handed to everything that reads
  // or writes under it.
  const paths = daemonPaths(home);
  const locs = locations(host, home);
  const instant = (): Instant => instantOf(new Date(clock.now()));
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
  // [LAW:single-enforcer] Route all child_process spawns through src/proc/launch:
  // this daemon's launcher meters them into daemon-stats and ends them with it.
  // The tmux restore at exit is the exception: it runs through the process's
  // one-shot launcher, after the last stats anyone reads.
  // Its work holds this one, so a closed daemon's launches are refused here,
  // whichever daemon is live by then.
  const launcher = inputs.launcher({
    inherited: host.env,
    stats: stats.launchStats,
    signal: closing.signal,
    // [LAW:one-source-of-truth] Pipe events are stamped on the clock renders
    // hold them against.
    now: instant,
    observeWarnings: launcherWarningsSaid(log, () => frameFeeds),
  });
  // [LAW:one-source-of-truth] The update watch and the lane edge read a pid
  // through this one probe, so a probe handed in reaches both. The process entry
  // (server.ts) asks its own before this daemon exists.
  const probe = inputs.probe(launcher);
  // Before every owner that arms a timer: storage that cannot be read refuses
  // the build with nothing running.
  const storage = inputs.storage(log, inputs.filesystem);
  // [LAW:single-enforcer] The one owner of every journal's turn, and so of
  // when session state may be written: the store refuses a write while no
  // turn is held.
  const journalTurns = new JournalTurns();
  const sessionState = new SessionState(journalTurns, storage.session);
  const settingsHistory = new SettingsHistory(
    inputs.filesystem,
    sessionState,
    log,
    storage.history,
  );
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
  });
  const handlerProbes = new ProbeArrivals();
  const renderSightings = new RenderSightings();
  // [LAW:one-source-of-truth] The doctor's stores, under this daemon's state
  // directory: its click files them, and daemon-stats answers what they hold
  // to `cc-candybar doctor`.
  const doctorStores = inputs.doctorStores(inputs.filesystem);
  // [LAW:single-enforcer] The daemon injects its log into both registries so
  // cache + watcher lifecycle events land in daemon.log at the right level.
  // Non-daemon consumers (var-system tests, future library use) take the
  // default debug-routed loggers and never write to daemon log files.
  const watcherRegistry = new WatcherRegistry({
    filesystem: inputs.filesystem,
    clock,
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
    clock,
  });
  // [LAW:single-enforcer] The daemon's one owner of every declared source's
  // runs, which the facts arm runs every view's `shell` and `file` sources
  // in, so one identity is one program however many sessions, directories or
  // configs declare it.
  const sourceRuns = new SourceRuns({
    launcher,
    clock,
    logger: log,
    ledger: refreshLedger,
    watchers: watcherRegistry,
    fileEvents,
  });
  const pricing = inputs.pricing({
    cacheRoot: cacheDir(home),
    closing: closing.signal,
    log,
  });
  const payloadProviders = createPayloadProviders({
    launcher,
    host,
    pricing,
    watchers: watcherRegistry,
    fileEvents,
    clock,
    logger: log,
    ledger: refreshLedger,
  });
  const { managedStorage } = payloadProviders;
  const navigationHistory = new NavigationHistory();
  // Each session's effect memory — when its effect came into force — held in
  // daemon memory only: a restarted daemon starts every session's effect again.
  const effectSessions = new EffectSessions<RenderedLine>();
  const menuIdle = sessionMenuIdle(() => parts, { clock, now: instant, log });
  // [LAW:single-enforcer] Whose links this daemon draws: every one addressed to
  // its home's name, and every `run` link signed, and verified on the click,
  // over the state directory's key.
  const links: RendererLinks = { to: home.name, signer: inputs.linkSigner };
  const runs = sessionRuns({ managedStorage, launcher, log, clock });
  // [LAW:one-source-of-truth] The one reader of which session a Claude Code
  // process holds: the render checkpoint's stamp, a pane's lookup and a
  // restart's check before its kill all ask it.
  const heldSession = inputs.heldSession(host.home);
  // [LAW:one-source-of-truth] The one edge every typing into Claude Code goes
  // through: a click's slash command and a lane's setup alike.
  const claudeInput = inputs.claudeInput(launcher);
  // [LAW:single-enforcer] The one owner of what turning an animation lane on or
  // off takes (src/daemon/lane-setup.ts), told the switches each of a session's
  // clicks moved, and each request's arrival for the setups owed to it.
  const laneSetups = sessionLaneSetups(() => parts, journalTurns, {
    edge: inputs.laneEdge(
      launcher,
      (sessionId) => frameFeeds.following(sessionId),
      closing.signal,
      probe,
      heldSession,
      inputs.filesystem,
      claudeInput,
    ),
    // A bar pane runs this bundle under the node running it now, with the
    // flags it runs with (tsx's loader, under the test harness).
    host: {
      bundle: bundle.path,
      node: bundle.node,
      home,
      preload: stableAttachPreload(bundle.path, host),
    },
    log,
  });
  // [LAW:single-enforcer] The one writer of the tmux status line lane's tmux
  // state (src/daemon/tmux-status.ts).
  const tmuxStatusLines = sessionTmuxStatusLines(() => parts, {
    launcher,
    heldSession,
    home,
    owner: paths.socket,
    bundle,
    signer: inputs.linkSigner,
    log,
  });
  // [LAW:one-source-of-truth] The home's link-id counter, which every tmux
  // status line's range ids are minted from. A fault is tried again once a
  // still period, the longest a bar's ⚠ waits to say it has gone.
  const linkIds = linkIdAllocator({
    file: paths.linkIds,
    clock,
    retryMs: FEED_PERIODS.still,
    log,
  });
  const paneVisibility = sessionPaneVisibility(() => parts, {
    launcher,
    clock,
    log,
  });
  // Each subscribed session's frames, drawn from its latest render request
  // (candybar-animation-wbxz.jmm.usl). A change to the session's own state — a
  // click — brings its next frame forward.
  const frameFeeds = sessionFrameFeeds(() => parts, {
    render: (sessionId, fps, at) => renderFrame(parts, sessionId, fps, at),
    visibility: paneVisibility,
    linkIds,
    clock,
    instant,
    log,
  });
  // [LAW:single-enforcer] What each session's renderers could not honour, as
  // their frames recorded it (src/daemon/render-warnings.ts).
  const renderWarnings = new RenderWarningRecords();
  // [LAW:one-source-of-truth] The daemon's one update fact: the update watch
  // writes it and every session's facts document reads it, so the box exists
  // before either.
  const updateFact = newUpdateFact();
  // [LAW:single-enforcer] The cache with its sessions' recorder wired over it
  // (src/daemon/session-recorder.ts): the record verb writes a session's
  // stream out of here.
  const { cache: renderCache, recorder } = sessionRenderCache({
    clock,
    stateDir: paths.state,
    locations: locs,
    sessionState,
    watchers: watcherRegistry,
    log,
    links,
    gates,
    providers: payloadProviders,
    updateFact,
    sourceRuns,
    history: settingsHistory,
    navigation: navigationHistory,
    // [LAW:single-enforcer] What every session's view draws from: its payload
    // derived over its document, its picks and its histories' depths.
    source: sessionSource,
    budgetBytes: () => renderCacheBudget(memoryLimitBytes),
    wake: (sessionId, cause) => frameFeeds.wake(sessionId, cause),
  });
  followFileEvents({ fileEvents, watcherRegistry, renderCache, frameFeeds });

  const { binaryWatch, updateWatch } = bundleWatches({
    clock,
    launcher,
    probe,
    filesystem: inputs.filesystem,
    bundle,
    stateDir: paths.state,
    registryUrl,
    fetch: inputs.fetch,
    gates,
    updateFact,
    exit,
    log,
  });

  const mismatchRuns = new MismatchRuns(journalTurns);
  const verbCtx = {
    gates,
    sessionState,
    stateDir: paths.state,
    filesystem: inputs.filesystem,
    installedLayers: renderCache.installedLayers,
    storedRoot: paths.storedRoot,
    locations: locs,
    journalTurns,
    log,
    launcher,
    now: instant,
    // The load the session's bar is drawn from: its cache entry's load
    // outcome, and what the config that entry renders left unused.
    // [LAW:no-ambient-temporal-coupling] Reloaded first, as a save does: a
    // doctor click is a verdict on the files as they are now, not on
    // whether the fs watcher has caught up with an edit made a moment ago.
    doctor: inputs.doctorEdge(
      launcher,
      (origin) => {
        renderCache.reload(origin, { kind: "doctor" });
        const entry = renderCache.getOrCreate(origin);
        return {
          layers: entry.configLayers,
          error: entry.lastError,
          warning: entry.lastWarning,
          unused: entry.state.unused,
          config: entry.state.config,
          repos: entry.repos,
        };
      },
      host,
      inputs.filesystem,
    ),
    doctorStores,
    probes: handlerProbes,
    clients: renderSightings,
    mismatchRuns,
    bundle: bundle.path,
    claudeInput,
    history: settingsHistory,
    navigation: navigationHistory,
    links,
    runs,
    ...verbsOverParts(() => parts),
  };

  const parts: DaemonParts = {
    home: host.home,
    storedRoot: paths.storedRoot,
    tmp: host.tmp,
    heldSession,
    launcher,
    log,
    clock,
    bundle: bundle.path,
    sourceDigest: bundle.digest,
    doctorStores,
    stats,
    handlerProbes,
    renderSightings,
    mismatchRuns,
    watcherRegistry,
    refreshLedger,
    fileEvents,
    gitEnv,
    payloadProviders,
    sessionState,
    rendererName: home.name,
    draw: partsDraw(() => parts),
    effectSessions,
    menuIdle,
    journalTurns,
    links,
    runs,
    sourceRuns,
    laneSetups,
    tmuxStatusLines,
    frameFeeds,
    linkIds,
    renderWarnings,
    renderCache,
    recorder,
    updateWatch,
    limits,
    verbCtx,
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
    // and close ends those (src/daemon/journal-turns.ts); a subscribe its request
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
      verbCtx.reloadConfig(origin);
    },
    arm() {
      closing.signal.throwIfAborted();
      fileEvents.start(paths.watchProbe);
      binaryWatch.arm();
      updateWatch.arm();
      limits.arm();
    },
    close(atExit) {
      closeDaemon(
        { ...parts, journalTurns, sessionState, closing, binaryWatch },
        atExit,
      );
      closed = true;
      return launcher.settled();
    },
  };
}

// [LAW:one-source-of-truth] The render cache every session's view is held in,
// its recorder wired over it, and what each of its events wakes: the daemon's,
// and the one a test that draws through the daemon's parts builds
// (test/helpers/daemon-parts.ts), so the two cannot wire it apart.
export function sessionRenderCache(
  deps: Omit<
    RenderDeps<SessionSource, CheckedRenderRequest>,
    "facts" | "source" | "storage"
  > & {
    readonly log: DaemonLogger;
    readonly providers: PayloadProviders;
    readonly updateFact: UpdateFact;
    readonly sourceRuns: SourceRuns;
    readonly history: Pick<SettingsHistory, "depth">;
    readonly navigation: Pick<NavigationHistory, "depth">;
    // What a view draws from, over the daemon's inputs to it: the daemon's
    // session source, or a case's over the same inputs.
    readonly source: (
      inputs: SessionSourceDeps,
    ) => SourceOf<SessionSource, CheckedRenderRequest>;
    // The bytes the cache may hold, read at each charge.
    readonly budgetBytes: () => number;
    // The session's feed is brought forward: a reload of the entry it draws
    // from, or anything else its view draws from moving.
    readonly wake: (sessionId: string, cause: "reload" | "data") => void;
  },
): {
  readonly cache: RenderCache<SessionSource, CheckedRenderRequest>;
  readonly recorder: SessionRecorder;
} {
  const {
    budgetBytes,
    wake,
    providers,
    updateFact,
    sourceRuns,
    history,
    navigation,
    source,
    ...render
  } = deps;
  const { log, sessionState, gates } = render;
  return recordedCache(
    (recording) =>
      new RenderCache<SessionSource, CheckedRenderRequest>(
        {
          ...render,
          storage: providers.managedStorage,
          // [LAW:single-enforcer] Where every session's facts come from: the
          // in-process arm over the daemon's own owners, which logs the
          // refreshes it makes through the one ledger, so a view's payload
          // logs none of them.
          facts: inProcessFacts({
            providers,
            update: () => updateFact.get(),
            runs: sourceRuns,
          }),
          source: source({
            providers,
            sessionState,
            stateGates: gates.state,
            history: (sessionId) => history.depth(sessionId),
            // Measured against the gate of the config the view draws with.
            navigation: (sessionId, config) =>
              navigation.depth(
                sessionId,
                sessionState,
                gates.state.gateFor(config),
              ),
          }),
        },
        {
          budgetBytes,
          observers: {
            // [LAW:no-silent-failure] Every config (re)load's outcome lands in
            // daemon.log with its cause — the operator's only record of why a load
            // ran, and whether a save was picked up cleanly, kept rendering
            // last-known-good behind an error, or resolved to a different file.
            onReload: (entry, sessions, cause, settled) => {
              log("info", configLoadedLine(entry, cause, settled));
              // A reload changes the bar of every session drawn from the entry,
              // even one that failed and kept the old config: its indicator says so.
              for (const sessionId of sessions) wake(sessionId, "reload");
            },
            // [LAW:single-enforcer] What a session's view draws from moved: its
            // feed's next frame is brought forward, whatever moved it: a request's
            // facts, a refresh landing after its deadline, a source publishing, a
            // pick. The dump link, which no view holds, wakes the same way.
            onViewChanged: (sessionId) => wake(sessionId, "data"),
            ...recording,
          },
        },
      ),
    log,
  );
}

// [LAW:one-source-of-truth] Each subscribed session's frames, drawn over the
// daemon's parts (`parts` is read only once they exist): the daemon's feed, and
// the one a test that draws through the daemon's parts builds.
export function sessionFrameFeeds(
  parts: () => DaemonParts,
  deps: Pick<
    FeedDeps<CheckedRenderRequest>,
    "render" | "clock" | "instant" | "log"
  > & {
    // Whether a session's pane is on a screen, and the following that asks.
    readonly visibility: PaneVisibility;
    // The counter every tmux status line's range ids are minted from.
    readonly linkIds: LinkIdAllocator;
  },
): FrameFeeds<CheckedRenderRequest> {
  const { visibility, linkIds, ...feed } = deps;
  return new FrameFeeds({
    ...feed,
    shown: (req) => visibility.shown(req.hints.tmux),
    watching: () => visibility.follow(),
    refreshes: () => parts().refreshLedger.totals(),
    encoders: laneEncoders(linkIds),
    // [LAW:no-ambient-temporal-coupling] A wake only moves the feed's timer,
    // which fires in a later turn. A click's turn is synchronous, so no frame
    // reads its writes before its commit.
    watch: (sessionId, onChange) =>
      reaction(() => parts().sessionState.revision(sessionId), onChange),
    lanes: (sessionId) => viewLanes(parts(), sessionId),
    // [LAW:single-enforcer] A feed's pin is its life: releasing it is the one
    // moment the feed stops drawing, so its drawn copies retire with it.
    pin: (sessionId) => {
      const { renderCache } = parts();
      const unpin = renderCache.pin(sessionId);
      return () => {
        renderCache.stopDrawing(sessionId, "feed");
        unpin();
      };
    },
    periods: FEED_PERIODS,
  });
}

// Which watched sessions' panes are on a screen, asked of their tmux servers
// once a second while some feed exists: a session nobody can see is drawn at
// the still rate however its bar moves, and one that comes into view is drawn
// at once.
export function sessionPaneVisibility(
  parts: () => DaemonParts,
  {
    launcher,
    clock,
    log,
  }: {
    readonly launcher: Launcher;
    readonly clock: Timekeeper;
    readonly log: DaemonLogger;
  },
): PaneVisibility {
  return new PaneVisibility({
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
      new Set(
        parts()
          .frameFeeds.watched()
          .flatMap(({ req }) => tmuxServersOf(req)),
      ),
    onAnswer: (socket, status) =>
      parts().tmuxStatusLines.answered(socket, status),
    // Only the sessions on a server whose view changed are drawn again.
    onChange: (sockets) =>
      parts().frameFeeds.wakeWhere("visibility", (req) =>
        tmuxServersOf(req).some((socket) => sockets.has(socket)),
      ),
    intervalMs: 1000,
    log,
  });
}

// [LAW:one-source-of-truth] The tmux server a session's bar is on, as the
// servers it is on: none outside tmux or from a client too old to say.
function tmuxServersOf({
  hints: { tmux },
}: CheckedRenderRequest): readonly string[] {
  return tmux === null || tmux === undefined ? [] : [tmux.socket];
}

// [LAW:single-enforcer] The one owner of what turning an animation lane on or
// off takes (src/daemon/lane-setup.ts), told the switches each of a session's
// clicks moved, and each request's arrival for the setups owed to it.
export function sessionLaneSetups(
  parts: () => DaemonParts,
  journalTurns: Pick<JournalTurns, "performing">,
  deps: {
    readonly edge: LaneEdge;
    readonly host: LaneHost;
    readonly log: DaemonLogger;
  },
): LaneSetups {
  return new LaneSetups({
    ...deps,
    // [LAW:one-source-of-truth] The session a setup acts on is its latest
    // request, the one a click reads too, read as the setup runs.
    latest: (sessionId) => {
      const req = parts().frameFeeds.latest(sessionId);
      return req === null ? null : laneSessionOf(req);
    },
    // A setup's steps in a pane take the order of what is typed into it, as a
    // slash click's typing does (src/daemon/apply.ts).
    paneOrder: (tmux, work) =>
      journalTurns.performing({ kind: "pane", tmux }, work),
  });
}

// [LAW:single-enforcer] The one writer of the tmux status line lane's tmux
// state (src/daemon/tmux-status.ts).
export function sessionTmuxStatusLines(
  parts: () => DaemonParts,
  {
    launcher,
    heldSession,
    home,
    owner,
    bundle,
    signer,
    log,
  }: {
    readonly launcher: Launcher;
    readonly heldSession: HeldSessionOf;
    readonly home: RendererHome;
    // The daemon's socket, which a row's click is handed back to.
    readonly owner: string;
    // The bundle a row's click runs, under the node and flags it runs with.
    readonly bundle: Pick<RunningBundle, "path" | "node">;
    readonly signer: LinkSigner;
    readonly log: DaemonLogger;
  },
): TmuxStatusLines {
  return new TmuxStatusLines({
    edge: {
      run: (socket, args) =>
        runTmuxAsync(launcher, { socket }, "tmux-status", args),
    },
    subscribe: (sessionId, sub) => parts().frameFeeds.subscribe(sessionId, sub),
    sessionInPane: (where) =>
      parts().frameFeeds.newestWhere(runsNowIn(where, heldSession)),
    // Run by tmux under its server's environment, so the renderer's home is
    // stated whole on the command, every variable of it.
    handler: [
      ...Object.entries(homeEnv(home)).map(([k, v]) => `${k}=${shellWord(v)}`),
      ...[...bundle.node, bundle.path].map(shellWord),
      "url-handle",
    ].join(" "),
    owner,
    // [LAW:one-source-of-truth] The renderer's name is its home's (docs/design/
    // gather-and-renderer.md, section 17): a click on a row this renderer
    // holds is resolved to this renderer's socket from the name alone.
    name: home.name,
    signer,
    log,
  });
}

// [LAW:no-silent-failure] Each change in whether what the daemon launches
// dies with it, and each pipe event, is said in daemon.log, and every feed
// redraws, so its warning comes on frames too.
export function launcherWarningsSaid(
  log: DaemonLogger,
  frameFeeds: () => FrameFeeds<CheckedRenderRequest>,
): (change: WarningChange) => void {
  return (change) => {
    if (change.kind === "launch-pipes") log("warn", change.text);
    else
      log(
        change.fault === null ? "info" : "warn",
        change.fault === null
          ? "launch lifeline running again"
          : `launch lifeline ${change.fault}; the next launch starts another`,
      );
    frameFeeds().wakeWhere("data", () => true);
  };
}

// [LAW:no-silent-failure] An edit made while file events went unheard is
// re-read when they resume, in every entry, and every feed redraws when
// delivery moves, so its row comes and goes on frames too.
// [LAW:no-ambient-temporal-coupling] Every directory watch is judged against
// the disk on the one period the daemon keeps time by: a folder replaced
// beneath a renamed ancestor reports nothing to the handle bound to the old
// one, and a directory the OS refused is heard again only by a retry.
export function followFileEvents({
  fileEvents,
  watcherRegistry,
  renderCache,
  frameFeeds,
}: Pick<
  DaemonParts,
  "fileEvents" | "watcherRegistry" | "renderCache" | "frameFeeds"
>): void {
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
}

// What a request's answer is drawn by, over the daemon's parts.
export function partsDraw(parts: () => DaemonParts): DaemonParts["draw"] {
  return (req, at, waitEndsAt, facts) =>
    drawAnswer(parts(), req, at, waitEndsAt, facts);
}

// [LAW:single-enforcer] Each session's idle clock and the timer that closes
// its menus (src/daemon/menu-idle.ts): a click restarts the clock, and the
// close is the journaled write a ✕ makes.
export function sessionMenuIdle(
  parts: () => DaemonParts,
  {
    clock,
    now,
    log,
  }: {
    readonly clock: Timekeeper;
    readonly now: () => Instant;
    readonly log: DaemonLogger;
  },
): MenuIdle {
  return new MenuIdle({
    clock,
    now,
    close: async (session, idle) => {
      await apply({ kind: "menu-idle", session, idle }, parts());
    },
    failed: (sessionId, error) =>
      sayUnapplied(log, "menu-idle", `session=${sessionId}`, error),
  });
}

// [LAW:no-ambient-temporal-coupling] The one owner of every `run` program in
// flight (src/daemon/runs.ts), closed with the daemon.
export function sessionRuns({
  managedStorage,
  launcher,
  log,
  clock,
}: {
  readonly managedStorage: PayloadProviders["managedStorage"];
  readonly launcher: Launcher;
  readonly log: DaemonLogger;
  readonly clock: Timekeeper;
}): Runs {
  return new Runs({
    supersede: (storage, sessionId) =>
      managedStorage.supersede(storage, sessionId),
    launch: launcher.launch,
    log,
    clock,
  });
}

// The two watches of the bundle the daemon runs: the binary watch, which ends
// the daemon on a changed bundle, and the update watch.
// [LAW:single-enforcer] The daemon is the process that observes the bundle
// it runs (the binary watch restarts it on rebuild), so it is the one place
// that knows whether something newer than that bundle exists — the source
// beside it, or a published release — and the one owner of the notice's
// clicks (src/daemon/update-notice.ts). The notice is a diagnostic channel of
// its own, folded between the error and warning channels.
export function bundleWatches({
  clock,
  launcher,
  probe,
  filesystem,
  bundle,
  stateDir,
  registryUrl,
  fetch,
  gates,
  updateFact,
  exit,
  log,
}: {
  readonly clock: Timekeeper;
  readonly launcher: Launcher;
  readonly probe: ProcessProbe;
  readonly filesystem: Filesystem;
  readonly bundle: RunningBundle;
  readonly stateDir: string;
  readonly registryUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly gates: Gates;
  readonly updateFact: UpdateFact;
  readonly exit: (code: number) => void;
  readonly log: DaemonLogger;
}): {
  readonly binaryWatch: BinaryWatch;
  readonly updateWatch: UpdateWatch;
} {
  const binaryWatch = makeBinaryWatch({
    clock,
    targets: bundle.targets,
    intervalMs: BIN_CHECK_INTERVAL_MS,
    filesystem,
    // The update notice's act rewrites the bundle, and a restart in the middle
    // would start the next daemon from a half-written one: a restart waits for
    // it. A success samples again at once; after a failure the next tick does.
    held: () => updateWatch.running(),
    exit: () => exit(0),
    log,
  });
  const updateWatch = makeUpdateWatch({
    fact: updateFact,
    clock,
    launcher,
    probe,
    entryUrl: bundle.entryUrl,
    digest: bundle.digest,
    // [LAW:one-source-of-truth] Keyed by the bundle the act rewrites, the one
    // this daemon runs from.
    actsDir: actsDir(stateDir, bundle.path),
    intervalMs: BIN_CHECK_INTERVAL_MS,
    releaseIntervalMs: RELEASE_CHECK_INTERVAL_MS,
    registryUrl,
    fetchImpl: fetch,
    gates,
    onApplied: () => binaryWatch.checkNow(),
    log,
  });
  return { binaryWatch, updateWatch };
}

// What a verb reads of the daemon's other parts — the session's cache entry,
// its lanes, its menus' idle clock, the update and the memory backstop — over
// the daemon's parts (`parts` is read only once they exist).
export function verbsOverParts(
  parts: () => DaemonParts,
): Pick<
  DaemonParts["verbCtx"],
  | "clickLanded"
  | "applyUpdate"
  | "serving"
  | "configFor"
  | "reloadConfig"
  | "sourcesFor"
  | "lanes"
  | "diagnosticCopy"
> {
  return {
    clickLanded: (sessionId) =>
      parts().menuIdle.clicked(sessionId, parts().verbCtx.now()),
    applyUpdate: () => parts().updateWatch.act(),
    serving: () => parts().limits.serving(),
    // The config a session's last render resolved from — the same entry the
    // render drew the bar with, so a save compares against the bar the user saw.
    configFor: (origin) => parts().renderCache.getOrCreate(origin).state.config,
    reloadConfig: (origin) =>
      parts().renderCache.reload(origin, { kind: "write" }),
    // The storage keys of the same entry `configFor` reads the config of.
    sourcesFor: (origin) =>
      parts().renderCache.getOrCreate(origin).state.sources,
    lanes: {
      of: (origin, sessionId) => lanesAt(parts(), origin, sessionId),
      clicked: (sessionId, before, after) =>
        laneClicked(parts(), sessionId, before, after),
      arrived: (req) => requestArrived(parts(), req),
      setup: (effect) => parts().laneSetups.setup(effect),
    },
    diagnosticCopy: (sessionId, by, key) =>
      parts().renderCache.drawnCopy(sessionId, by, key),
  };
}

// One cadence for "how often does the daemon look at its build on disk" —
// the binary watch (exit on a changed bundle) and the update watch (does the
// bundle match `src/`) both sample on it.
export const BIN_CHECK_INTERVAL_MS = 60 * 1000;
// The registry is a network resource with releases hours apart; ask rarely.
export const RELEASE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// What a daemon's close ends: its parts, with the owners of their turns and
// their store whole, the signal that ends its launches, and the bundle watch.
export interface DaemonOwners extends Omit<
  DaemonParts,
  "journalTurns" | "sessionState"
> {
  readonly journalTurns: JournalTurns;
  readonly sessionState: SessionState;
  readonly closing: AbortController;
  readonly binaryWatch: Pick<BinaryWatch, "close">;
}

// [LAW:single-enforcer] The one teardown of what a daemon holds: the daemon's
// close, and a test's that built the daemon's parts.
// [LAW:no-silent-failure][LAW:dataflow-not-control-flow] Every teardown step
// runs, each in order, and one that throws is logged by name without
// skipping the rest: the session state still flushes after a close failed.
export function closeDaemon(owners: DaemonOwners, atExit: TmuxAtExit): void {
  const {
    journalTurns,
    tmuxStatusLines,
    closing,
    laneSetups,
    frameFeeds,
    linkIds,
    menuIdle,
    updateWatch,
    binaryWatch,
    limits,
    recorder,
    renderCache,
    payloadProviders: {
      gitProvider: gitService,
      usageStore,
      tmuxService,
      hostService,
      managedStorage,
    },
    runs,
    sourceRuns,
    fileEvents,
    watcherRegistry,
    sessionState,
    log,
  } = owners;
  const teardown: ReadonlyArray<readonly [string, () => void]> = [
    // [LAW:no-ambient-temporal-coupling] Before the abort that wakes it,
    // the journal in flight commits what landed; none opens after.
    ["journalTurns close", () => journalTurns.close()],
    // [LAW:single-enforcer] Every tmux status line this daemon laid out is put
    // back before it goes (src/daemon/tmux-status.ts).
    ["tmuxStatusLines restore", () => tmuxStatusLines.restoreAll(atExit)],
    // [LAW:no-ambient-temporal-coupling] Nothing launches from here on, what
    // is in flight is terminated, whichever owner's work it was, and the
    // launcher's lifeline goes.
    ["launches abort", () => closing.abort(new Error("the daemon closed"))],
    // A lane setup still queued behind the session's earlier effects is
    // refused, as a queued run is (`runs close`).
    ["laneSetups close", () => laneSetups.close()],
    ["frameFeeds close", () => frameFeeds.close()],
    ["linkIds close", () => linkIds.close()],
    ["menuIdle dispose", () => menuIdle.dispose()],
    ["updateWatch close", () => updateWatch.close()],
    ["binaryWatch close", () => binaryWatch.close()],
    ["limits disarm", () => limits.disarm()],
    // Every open recording ends, its file whole, while the views it
    // follows are still served.
    ["recorder close", () => recorder.close()],
    // Before the sources and the storage its states hold.
    ["renderCache close", () => renderCache.close()],
    ["gitService close", () => gitService.close()],
    ["usageStore close", () => usageStore.close()],
    ["tmuxService close", () => tmuxService.close()],
    ["hostService close", () => hostService.close()],
    ["runs close", () => runs.close()],
    // After the render cache: its states' registries release their holds
    // first, so this close drops nothing a registry still reads.
    ["sourceRuns close", () => sourceRuns.close()],
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
}
