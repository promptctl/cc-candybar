import fs from "node:fs";
import { linkSignerFromKeyFile } from "./link-key.js";
import { Runs } from "./runs.js";
import net from "node:net";
import v8 from "node:v8";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspect, parseArgs } from "node:util";
import {
  daemonDir,
  ensureSocketParentSafe,
  leasePath,
  leasePathFor,
  socketPath,
  sessionStatePath,
  settingsHistoryPath,
  stateDir,
} from "./paths";
import {
  arbitrateSocket,
  readLease,
  removeLeaseIfOwned,
  writeLease,
} from "./socket-lease";
import {
  makeOwnershipWatch,
  readSocketIdentity,
  type SocketIdentity,
} from "./socket-ownership";
import {
  readStartTime,
  readOwnStartTime,
  sameLiveProcess,
} from "./process-fingerprint";
import {
  admitDaemon,
  realBreakerDeps,
  releaseRegistration,
  readRegistryEntry,
} from "./fork-bomb-breaker";
import { dlog } from "./log";
import { makeUpdateWatch, UPDATE_DISMISSED_KEY } from "./update-notice";
import { makeBinaryWatch } from "./binary-watch";
import { LANE_FRAMES } from "./lane-frames";
import { REGISTRY_URL } from "../install/currency";
import { stableAttachPreload } from "../install/index.js";
import { isAbsolute } from "node:path";
import { explicitConfigPath } from "../utils/user-path";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  encodeJsonFrame,
  makeFrameReader,
  parseClientHints,
  refusedHints,
  refusedArgsError,
  refusedHintsError,
  sanitizeClientVersion,
} from "./protocol";
import type {
  ClickRequest,
  ClientHints,
  RefusedArg,
  RenderRequest,
  Request,
  Response,
  SubscribeRequest,
} from "./protocol";
import { parseSessionId, type SessionId } from "./session-id";
import { createPayloadProviders } from "./payload-providers";
import { RefreshLedger } from "../utils/refresh-ledger";
import { repoQuestions } from "./repo-configs";
import {
  configLoadedLine,
  RenderCache,
  renderCacheBudget,
  type CacheEntry,
  type DslRenderState,
  type SessionHold,
  type SessionView,
} from "./cache/render";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats, type SourceSnapshots } from "./stats";
import {
  makeLimits,
  mb,
  realLimitsDeps,
  memoryLimitBytes,
  type LimitsHandle,
} from "./limits";
import { armParentWatchdog, anchorFromEnv, pidAlive } from "./parent-watchdog";
import { resetSpawnBackoff } from "./acquire";
import { SessionState } from "./session-state";
import { FileSessionStorage } from "./session-state-file";
import { SettingsHistory, fileHistoryStorage } from "./settings-history";
import { NavigationHistory } from "./navigation-history";
import { stateGate } from "./verbs/state-validators";
import {
  VERBS,
  clickLaunch,
  clickSessionOf,
  closeIdleMenus,
  BadVerbArgs,
  SESSION_RENDER_ORIGIN_KEY,
  SESSION_CLIENT_HINTS_KEY,
  encodeRenderOrigin,
  sessionRenderOrigin,
  type RenderOrigin,
} from "./verbs";
import { validateHookData } from "../utils/schema-validator.js";
import { transcriptReads } from "../utils/transcript-fs.js";
import { fileStores, productionEdge, readStores } from "../doctor/edge";
import { ProbeArrivals } from "../doctor/handler-probe";
import type { ClickArrival } from "../doctor/sightings";
import {
  RenderSightings,
  rateLimitsSeen,
  roleOf,
  transcriptSaid,
  answeredOf,
  type FrameSeen,
  type RateLimitsSeen,
} from "./render-sightings";
import { claudeConfigDir } from "../claude-settings";
import { launch, setLaunchStats } from "../proc/launch";
import { decodeWire } from "./verb-error";
import { buildDebugSnapshot } from "./debug";
import { DEBUG_WHATS, isDebugWhat } from "./debug-types";
import { drawDsl, type RenderWarning } from "../dsl/render.js";
import type { DrawnMotion } from "../render/drawn-motion.js";
import {
  renderStripCells,
  type BuildLineOptions,
  type ColorCompatibility,
} from "../render/strip.js";
import { floorOf } from "../config/globals-fields.js";
import type { RichText } from "@promptctl/rich-js";
import {
  declareLanes,
  renderOptionsOf,
  renderWidth,
  gitOptionsFromClosure,
  prFactOf,
  sourcesFactOf,
  settlePayload,
  refreshedFact,
  type Refreshed,
  todayOf,
  type PayloadInputs,
} from "./render-payload.js";
import { sessionSource, type SessionSource } from "./session-source.js";
import { isPending } from "../utils/outcome.js";
import {
  laneSwitches,
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "../config/effective-globals.js";
import { EffectSessions, type PassageFrame } from "../render/effect.js";
import {
  FEED_PERIODS,
  feedsFact,
  FrameFeeds,
  type FeedFrame,
} from "./frame-feed.js";
import {
  LANE_NAMES,
  LANES,
  parseLane,
  ANSWERING,
  type Drawing,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import {
  answeredClickError,
  clickErrorAt,
  type ClickErrorRecord,
} from "./click-error.js";
import { newestWins } from "../utils/newest-wins.js";
import {
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  PaneVisibility,
} from "./pane-visibility.js";
import { runTmux, runTmuxAsync } from "../proc/tmux.js";
import { TmuxStatusLines } from "./tmux-status.js";
import { VERB_TMUX_STATUS_CLICK } from "../click/wire.js";
import { parseHandlerUrl } from "../install/index.js";
import { shellWord } from "../shell-word.js";
import { reaction } from "mobx";
import { setImmediate } from "node:timers";
import type { RenderedLine } from "../dsl/node-registry.js";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { LaneSetups, type LaneSession } from "./lane-setup.js";
import { productionLaneEdge } from "./lane-edge.js";
import { handedOffTo, laneHandoff } from "./lane-handoff.js";
import {
  collectDiagnostics,
  diagnosticsProjection,
  handoffRows,
  type DiagnosticList,
  viewedIndex,
  viewerRowCap,
  viewerRows,
  type DiagnosticGeometry,
} from "../render/diagnostics.js";
import { DIAGNOSTICS_VIEWING } from "../config/door.js";
import { RenderWarningRecords } from "./render-warnings.js";
import { instantOf, type Instant } from "../utils/instant.js";
import { MenuIdle } from "./menu-idle.js";
import {
  REQUEST_TIMEOUT_MS,
  parseClientDeadline,
  waitBudgetMs,
  type ClientDeadline,
} from "./request-deadline.js";
import { waitWithin } from "../utils/reading.js";
import {
  noteFacts,
  requestEvent,
  type RequestFacts,
  type RequestOutcome,
} from "./request-event.js";

// [LAW:one-source-of-truth] one cache instance per daemon process — multiple
// instances would defeat the share-across-sessions invariant.
const stats = new RuntimeStats();
const handlerProbes = new ProbeArrivals();
const renderSightings = new RenderSightings();
// The bundle this daemon runs: the file the entry was loaded from, as the
// build watch and the update notice read it — what daemon-stats and the
// doctor's click name the install by.
const DAEMON_BUNDLE = fileURLToPath(import.meta.url);
// [LAW:one-source-of-truth] The doctor's stores, under this daemon's state
// directory: its click files them, and daemon-stats answers what they hold
// to `cc-candybar doctor`.
const DOCTOR_STORES = fileStores(stateDir());
// [LAW:single-enforcer] Route all child_process spawns through src/proc/launch.
// Installing the metering handle here makes subprocess counts visible in
// daemon-stats.
setLaunchStats(stats.launchStats);
// [LAW:single-enforcer] The daemon injects `dlog` into both registries so
// cache + watcher lifecycle events land in daemon.log at the right level.
// Non-daemon consumers (var-system tests, future library use) take the
// default debug-routed loggers and never write to daemon log files.
const watcherRegistry = new WatcherRegistry({
  counters: stats,
  logger: dlog,
});
// [LAW:one-source-of-truth] One provider per data shape, shared across every
// render in this daemon, built by the one constructor every renderer uses
// (payload-providers.ts). The render cache owns DSL-state-per-config; these
// serve the augmented payload that flows through every render.
// [LAW:single-enforcer] The daemon's one record of every source's refreshes:
// the providers', and each config's user sources (the render cache's).
const refreshLedger = new RefreshLedger(dlog);
const payloadProviders = createPayloadProviders({
  watchers: watcherRegistry,
  logger: dlog,
  ledger: refreshLedger,
});
const {
  gitProvider: gitService,
  usageStore,
  tmuxService,
  hostService,
  managedStorage,
} = payloadProviders;
// [LAW:locality-or-seam] Constructed ephemeral so importing this module (CLI
// relay, subcommands) does no disk I/O. The daemon binds the file-backed
// storage in runDaemon(), making it the sole reader/writer of the state file.
const sessionState = new SessionState();
// [LAW:locality-or-seam] Same terms: ephemeral until runDaemon binds its file.
const settingsHistory = new SettingsHistory(sessionState, dlog);
const navigationHistory = new NavigationHistory();
// Each session's effect memory — when its effect came into force — held in
// daemon memory only: a restarted daemon starts every session's effect again.
const effectSessions = new EffectSessions<RenderedLine>();
// [LAW:single-enforcer] Each session's idle clock and the timer that closes
// its menus (src/daemon/menu-idle.ts): a click restarts the clock, and the
// close is the journaled write a ✕ makes.
const menuIdle = new MenuIdle({
  now: () => instantOf(new Date()),
  close: (sessionId, idle) => closeIdleMenus(sessionId, idle, verbCtx),
  failed: (sessionId, error) =>
    dlog(
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
  launch,
  state: sessionState,
  log: dlog,
  now: () => instantOf(new Date()),
});
// How this daemon's node runs its bundle: what a bar pane runs, and what a
// click in a tmux status line runs to hand the click back.
const DAEMON_NODE: readonly string[] = [process.execPath, ...process.execArgv];
// [LAW:single-enforcer] The one owner of what turning an animation lane on or
// off takes (src/daemon/lane-setup.ts), told the switches each of a session's
// clicks moved, and each request's arrival for the setups owed to it.
const laneSetups = new LaneSetups({
  edge: productionLaneEdge((sessionId) => frameFeeds.following(sessionId)),
  // A bar pane runs this bundle under the node running it now, with the
  // flags it runs with (tsx's loader, under the test harness).
  host: {
    bundle: DAEMON_BUNDLE,
    node: DAEMON_NODE,
    socket: socketPath(),
    preload: stableAttachPreload(DAEMON_BUNDLE),
  },
  state: sessionState,
  log: dlog,
  now: () => instantOf(new Date()),
  defer: (run) => void setImmediate(run),
});
// [LAW:single-enforcer] The one writer of the tmux status line lane's tmux
// state (src/daemon/tmux-status.ts).
const tmuxStatusLines: TmuxStatusLines = new TmuxStatusLines({
  edge: {
    run: (socket, args, stdin) =>
      runTmuxAsync({ socket }, "tmux-status", args, stdin),
    runSync: (socket, args, stdin) =>
      runTmux({ socket }, "tmux-status", args, stdin),
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
    ...[...DAEMON_NODE, DAEMON_BUNDLE].map(shellWord),
    "url-handle",
  ].join(" "),
  owner: socketPath(),
  log: dlog,
});
// Each subscribed session's frames, drawn from its latest render request
// (candybar-animation-wbxz.jmm.usl). A change to the session's own state — a
// click — brings its next frame forward.
const frameFeeds: FrameFeeds<CheckedRenderRequest> = new FrameFeeds({
  render: (sessionId, fps) => renderFrame(sessionId, fps),
  // [LAW:no-ambient-temporal-coupling] A wake only moves the feed's timer,
  // which fires in a later turn, so a click's whole run of writes and its
  // journal commit land before a frame of it is drawn.
  watch: (sessionId, onChange) =>
    reaction(() => sessionState.revision(sessionId), onChange),
  lanes: (sessionId) => viewLanes(sessionId),
  pin: (sessionId) => renderCache.pin(sessionId),
  shown: (req) => paneVisibility.shown(req.hints.tmux),
  watching: () => paneVisibility.follow(),
  refreshes: () => refreshLedger.totals(),
  periods: FEED_PERIODS,
  now: () => performance.now(),
  log: dlog,
});
// Which watched sessions' panes are on a screen, asked of their tmux servers
// once a second while some feed exists: a session nobody can see is drawn at
// the still rate however its bar moves, and one that comes into view is drawn
// at once.
const paneVisibility: PaneVisibility = new PaneVisibility({
  listPanes: (socket) =>
    runTmuxAsync({ socket }, "frames.visibility", [
      "list-panes",
      "-a",
      "-F",
      LIST_PANES_FORMAT,
    ]),
  listClients: (socket) =>
    runTmuxAsync({ socket }, "frames.visibility", [
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
  log: dlog,
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
    sessionState,
    watchers: watcherRegistry,
    log: dlog,
    storage: managedStorage,
    signer: linkSigner,
    ledger: refreshLedger,
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
    // [LAW:no-ambient-temporal-coupling] The budget as boot established it
    // (establishLimits, which refuses a malformed override through daemon.log):
    // a render before that is the boot-order bug establishedLimits names.
    budgetBytes: () => {
      establishedLimits();
      return renderCacheBudget(budgetBytes);
    },
    observers: {
      // [LAW:no-silent-failure] Every config (re)load's outcome lands in
      // daemon.log with its cause — the operator's only record of why a load
      // ran, and whether a save was picked up cleanly, kept rendering
      // last-known-good behind an error, or resolved to a different file.
      onReload: (entry, sessions, cause, settled) => {
        dlog("info", configLoadedLine(entry, cause, settled));
        // A reload changes the bar of every session drawn from the entry,
        // even one that failed and kept the old config: its indicator says so.
        for (const sessionId of sessions) frameFeeds.wake(sessionId, "reload");
      },
      // [LAW:single-enforcer] What a session's view draws from moved: its
      // feed's next frame is brought forward, whatever moved it: a request's
      // facts, a refresh landing after its deadline, a source publishing, a
      // pick. The dump link, which no view holds, wakes the same way.
      onViewChanged: (sessionId) => frameFeeds.wake(sessionId, "data"),
    },
  },
);

// One cadence for "how often does the daemon look at its build on disk" —
// the binary watch (exit on a changed bundle) and the update watch (does the
// bundle match `src/`) both sample on it.
const BIN_CHECK_INTERVAL_MS = 60 * 1000;
// The registry is a network resource with releases hours apart; ask rarely.
const RELEASE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Watch the resolved entry point, not the bin shim — a build updates
// dist/index.mjs but the bin/cc-candybar shim never changes — and argv[1]
// beside it (global installs, symlinks).
const binaryWatch = makeBinaryWatch({
  // One target per path: run as `node dist/index.mjs`, both name one file.
  targets: [
    ...new Set([
      ...(import.meta.url.startsWith("file://")
        ? [fileURLToPath(import.meta.url)]
        : []),
      ...(process.argv[1] ? [process.argv[1]] : []),
    ]),
  ],
  intervalMs: BIN_CHECK_INTERVAL_MS,
  stat: fs.statSync,
  exit: () => shutdown(0),
  log: dlog,
});

// [LAW:single-enforcer] The daemon is the process that observes the bundle
// it runs (the binary watch restarts it on rebuild), so it is the one place
// that knows whether something newer than that bundle exists — the source
// beside it, or a published release — and the one owner of the notice's
// clicks (src/daemon/update-notice.ts). The notice is a diagnostic channel of
// its own, folded between the error and warning channels.
const updateWatch = makeUpdateWatch({
  entryUrl: import.meta.url,
  intervalMs: BIN_CHECK_INTERVAL_MS,
  releaseIntervalMs: RELEASE_CHECK_INTERVAL_MS,
  registryUrl: process.env.CC_CANDYBAR_REGISTRY_URL ?? REGISTRY_URL,
  fetchImpl: fetch,
  onApplied: () => binaryWatch.checkNow(),
  log: dlog,
});

// Daemon entry point. Tries to bind the Unix socket — atomic bind() is the
// single-instance enforcer (two daemons cannot both bind the same path; the
// kernel makes duplicate-daemon unrepresentable). Listens for one request per
// connection. Any uncaught error exits non-zero; the next client obtains a
// fresh daemon via obtainDaemonKick() (fire-and-forget caller) or
// obtainDaemon() (caller waits for readiness) in src/daemon/acquire.ts.
// [LAW:one-source-of-truth] Our own kernel start-time, read once at startup and
// stamped into our lease so a future daemon's arbitration can prove whether our
// pid still names THIS process or a recycled ghost (process-fingerprint.ts).
// null when this host cannot fingerprint (no `ps`) — readers then fall back to
// kill(pid,0), no worse than before the fingerprint existed.
let myStartTime: string | null = null;

// The registry path this daemon claimed in the fork-bomb breaker's population
// registry (fork-bomb-breaker.ts), or null when exempt (the canonical
// production socket) or never reached (refused before claiming one). Released
// on shutdown so a graceful exit frees its slot immediately rather than
// waiting for the next boot's stale-sweep.
let breakerRegistryPath: string | null = null;

// The parsed memory budget (bytes); set by establishLimits.
let budgetBytes = 0;

export function runDaemon(): void {
  // Catch-alls log + exit so the supervisor (the next client) can restart us.
  // [LAW:no-defensive-null-guards] These are *trust boundaries* — we are
  // catching all of unknown space, not skipping known optional values.
  // [LAW:single-enforcer] Registered FIRST, before any of the startup calls
  // below that can throw synchronously (admitDaemon's ensureDirSafe/writeEntry,
  // ensureSocketParentSafe) — otherwise an early throw is a raw unhandled
  // exception (stack trace to stderr, bypassing the clean shutdown(1) log +
  // SIGKILL backstop) rather than funneling through the same death path as
  // every other failure mode.
  process.on("uncaughtException", (err) => {
    dlog("error", `uncaughtException: ${err.stack || err.message}`);
    shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    dlog("error", `unhandledRejection: ${String(reason)}`);
    shutdown(1);
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      dlog("info", `received ${sig}, shutting down`);
      shutdown(0);
    });
  }

  // [LAW:effects-at-boundaries] The memory budget is parsed here, before any
  // resource is committed — a malformed override is refused before the breaker
  // registers us, before the bind, before the lease, and before a `daemon up`
  // line could claim a boot that is about to die. Parsed once, threaded into
  // the limits and the boot line.
  // [LAW:single-enforcer] Refused through the same death funnel as every other
  // boot failure. A synchronous throw here is NOT uncaught — it lands in
  // index.ts's catch, whose stderr the detached spawn discards — so the one
  // line that says why the daemon never came up would go nowhere.
  try {
    establishLimits(process.env);
  } catch (err) {
    dlog("error", `refusing to boot: ${(err as Error).message}`);
    shutdown(1);
    return;
  }

  // [LAW:single-enforcer] The fork-bomb circuit breaker runs FIRST among the
  // resource-committing steps (no dir created, no socket touched, no session
  // state loaded) — the whole point of a load-independent backstop is that it
  // holds even when everything downstream of it is thrashing. Own start-time
  // must be read first: it is both this check's identity and the lease's
  // fingerprint later, so it is read exactly once and threaded through both
  // (see realBreakerDeps' doc comment).
  myStartTime = readOwnStartTime(process.pid);
  const admission = admitDaemon(realBreakerDeps(myStartTime));
  if (!admission.decision.allow) {
    dlog(
      "warn",
      `fork-bomb breaker: ${admission.decision.reason}; refusing to boot`,
    );
    shutdown(1);
    return;
  }
  breakerRegistryPath = admission.registryPath;

  fs.mkdirSync(daemonDir(), { recursive: true });
  // [LAW:single-enforcer] Verify the socket parent is uid==me + mode 0700 +
  // not a symlink before we bind. Without this check, a same-host attacker
  // could pre-create the predictable `/tmp/cc-candybar-<uid>` directory and
  // squat the socket name. The check applies regardless of CC_CANDYBAR_SOCKET
  // location — every bind path goes through the same trust precondition.
  // No symmetric client-side check: the daemon is the sole creator, so a
  // successful bind already proves the parent is trusted. Failure here surfaces
  // as a daemon exit; the client falls back to the last cached render.
  ensureSocketParentSafe(socketPath());

  // Bind disk persistence now that we know we are the daemon process — load
  // prior session state and become the sole writer of the state file.
  sessionState.useStorage(
    new FileSessionStorage(sessionStatePath(), 500, dlog),
  );
  settingsHistory.useStorage(fileHistoryStorage(settingsHistoryPath(), dlog));
  // [LAW:single-enforcer] Same death funnel as the signals and the memory backstop:
  // the watchdog calls shutdown(0), it never exits on its own. A production
  // daemon has no spawner to outlive (env unset) and arms an inert handle; only
  // a test-spawned daemon is anchored, so this is invisible to the real daemon.
  armParentWatchdog({
    anchor: anchorFromEnv(process.env),
    isAlive: pidAlive,
    onOrphaned: (reason) => {
      dlog("info", `parent watchdog: ${reason}; shutting down`);
      shutdown(0);
    },
  });

  const server = net.createServer({ allowHalfOpen: false }, (sock) => {
    handleConnection(sock);
  });

  // [LAW:single-enforcer] The atomic bind() is the daemon-singleton enforcer.
  // Two daemons cannot both bind the same Unix socket path; the kernel makes
  // duplicate-daemon unrepresentable. The pidfile is diagnostic only — never
  // load-bearing for exclusion.
  bindOrAttachAndExit(server, socketPath(), /* retried */ false);
}

// [LAW:nothing-unseen] Every source's refreshes from the one ledger, beside
// how many homes of each scope the owners keep and how many a view holds.
function sourceSnapshots(): SourceSnapshots {
  const git = gitService.getStats();
  const tmux = tmuxService.getStats();
  const today = usageStore.scanStats();
  const storage = managedStorage.stats();
  const cache = renderCache.stats;
  return {
    records: refreshLedger.snapshot(),
    homes: {
      daemon: 1,
      configDir: today.entries,
      repo: git.size,
      directory: cache.size,
      session: usageStore.getStats().size,
      view: cache.views,
      pane: tmux.entries,
    },
    held: {
      git: git.held,
      tmux: tmux.held,
      host: hostService.held(),
      today: today.held,
      pluginStorage: storage.held,
    },
    pluginStorage: {
      folders: storage.folders,
      faults: storage.faults,
      lost: storage.lost,
      probes: storage.probes,
      probeFailures: storage.probeFailures,
      stalled: storage.stalled,
      stalls: storage.stalls,
    },
  };
}

// [LAW:dataflow-not-control-flow] One operation ("bring this server up or
// discover an existing one"). The bind result is the data that decides the
// next step; callers do not get to choose whether to spawn.
function bindOrAttachAndExit(
  server: net.Server,
  sockPath: string,
  retried: boolean,
): void {
  server.removeAllListeners("error");
  // [LAW:no-ambient-temporal-coupling] server.listen(path, cb) registers cb as
  // a ONE-TIME 'listening' listener. A first listen that fails EADDRINUSE never
  // fires 'listening', so its callback stays pending; the reclaim retry adds a
  // second. Without clearing the stale one, a successful rebind fires BOTH and
  // onListening runs twice — double-arming the memory backstop + watchers. Clear
  // pending 'listening' listeners so exactly one onListening fires per bind.
  server.removeAllListeners("listening");
  server.once("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") {
      dlog("error", `server error: ${err.message}`);
      shutdown(1);
      return;
    }
    if (retried) {
      // Lost a rebind race with another duplicate. The kernel arbitrated; we
      // are the loser. Exit cleanly so the winner serves.
      dlog("info", "lost rebind race; another daemon is alive — exiting");
      process.exit(0);
      return;
    }
    handleAddressInUse(server, sockPath);
  });
  server.listen(sockPath, () => onListening(sockPath));
}

// [LAW:one-source-of-truth] EADDRINUSE arbitration consults the socket-derived
// pid lease, NEVER a connect probe. The path already exists (a live daemon, or
// a stale file from a crashed one); the lease's owner pid + kill(pid,0) decides
// which. This is fully synchronous — reading the lease and testing liveness are
// both sync — so there is no await gap for a concurrent recoverer to race
// through (the old async probe had two such gaps and a hand-rolled re-check).
//
// [LAW:effects-at-boundaries] The decision is the pure arbitrateSocket fold
// over the lease read + injected pidAlive; the kill / unlink / rebind effects
// are performed here at the edge.
function handleAddressInUse(server: net.Server, sockPath: string): void {
  // [LAW:one-source-of-truth] Derive the lease from the SAME sockPath threaded
  // through unlink + rebind below, not the re-derived global — one identity
  // source for the whole arbitration.
  const decision = arbitrateSocket(
    readLease(leasePathFor(sockPath)),
    (pid, startTime) =>
      sameLiveProcess(pid, startTime, { readStartTime, pidAlive }),
  );
  if (decision.kind === "attach-and-exit") {
    dlog("info", `EADDRINUSE: ${decision.reason} — exiting`);
    process.exit(0);
    // [LAW:no-ambient-temporal-coupling] process.exit() halts synchronously, so
    // the reclaim below is already unreachable — but the explicit return makes
    // that structural, matching the sibling `retried` branch, so no future
    // refactor of the exit path can accidentally fall through to unlinking a
    // live daemon's socket.
    return;
  }
  dlog(
    "warn",
    `EADDRINUSE: ${decision.reason} — unlinking stale socket and rebinding`,
  );
  // [LAW:no-defensive-null-guards] If unlink fails (permissions, read-only
  // FS), the retry will hit EADDRINUSE again, exit 0, and leave the system
  // in the worst state: no daemon + stale socket blocking future starts.
  // Surface unrecoverable failures loudly. ENOENT is fine — the goal was
  // "make the path bindable" and a missing path already satisfies that.
  try {
    fs.unlinkSync(sockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      dlog(
        "error",
        `cannot unlink stale socket ${sockPath}: ${(e as Error).message}`,
      );
      shutdown(1);
      return;
    }
  }
  bindOrAttachAndExit(server, sockPath, /* retried */ true);
}

function onListening(sockPath: string): void {
  // [LAW:no-ambient-temporal-coupling] Capture the bound socket's kernel
  // identity (dev+ino) as the fingerprint the ownership self-check re-stats
  // against, BEFORE claiming the lease. Captured from the PATH, not the bound
  // FD: for an AF_UNIX listener, fstat(fd) reports the socket's inode in the
  // socket namespace — not the filesystem-entry inode that stat(path) sees — so
  // the FD yields no path-comparable identity. stat(path), taken as close to the
  // bind as possible, is the only path-comparable truth available.
  //
  // [FRAMING:representation] This inode capture still cannot close the capture
  // race on its own: if a second daemon completed its full EADDRINUSE →
  // read-lease → unlink → rebind cycle in the single event-loop tick between
  // bind() and this 'listening' callback, we stat the path and capture the
  // THIEF's inode as "ours". No race-free handle on our own socket's path
  // identity exists (an AF_UNIX listener's fstat is a different namespace's
  // inode), so the captured inode cannot be made trustworthy. But that is no
  // longer the immortal orphan it was (brandon-daemon-lifecycle-2b3.4 RESIDUAL
  // 2): the ownership self-check now ALSO requires the lease to still name us,
  // and a real thief writes its own pid into the lease — so a displaced daemon
  // drains within a bounded number of intervals instead of reading `owned`
  // forever (see checkOwnership). The absent/unreadable case below still exits
  // toward the SAFE direction without writing a lease that would stomp a thief's.
  const boundRead = readSocketIdentity(sockPath);
  if (boundRead.kind !== "present") {
    dlog(
      "warn",
      `no ownable socket at bind callback (${boundRead.kind}); exiting`,
    );
    shutdown(0);
    return;
  }

  // [LAW:no-ambient-temporal-coupling] Claim ownership FIRST among the post-bind
  // effects — before chmod or any other work — so the window between winning the
  // bind and the lease naming us is as small as possible. A second daemon that
  // binds in that sub-ms gap reads an absent lease and reclaims (displacing us);
  // the ownership self-check below makes that self-healing, but keeping the
  // window minimal keeps it vanishingly rare.
  // [LAW:one-source-of-truth] Derive the lease from the same sockPath we bound,
  // matching handleAddressInUse's read — one identity source across write + read.
  writeLeaseFile(sockPath);
  try {
    fs.chmodSync(sockPath, 0o600);
  } catch (e) {
    dlog("warn", `chmod socket failed: ${(e as Error).message}`);
  }
  dlog(
    "info",
    // [FRAMING:representation] Report the heap cap V8 actually applied (the
    // territory), not the flag the spawner meant to pass (the map) — the one
    // question a silent SIGABRT crash-loop leaves open is "which cap was live".
    `daemon up: pid=${process.pid} v=${PROTOCOL_VERSION} sock=${sockPath} ` +
      `heapCap=${mb(v8.getHeapStatistics().heap_size_limit)}MB ` +
      `memoryLimit=${mb(budgetBytes)}MB`,
  );
  // [LAW:single-enforcer] This bind is the one process-wide fact that answers
  // "did an outage just end" — see resetSpawnBackoff's doc comment in
  // acquire.ts. Any consecutive-spawn backoff accumulated getting here no
  // longer applies once a daemon is actually serving.
  resetSpawnBackoff();
  binaryWatch.arm();
  updateWatch.arm();
  establishedLimits().arm();
  armOwnershipWatch(sockPath, boundRead.identity);
}

// --- socket-ownership self-check ---
//
// [LAW:single-enforcer] The sole enforcer of "serving implies owning the socket
// path over time" (brandon-daemon-lifecycle-2b3.2). Each interval it re-reads
// BOTH representations a displacer can touch — the path's kernel identity (still
// the inode we bound?) and the lease (still names our pid?) — and drains through
// the SAME shutdown funnel as signals, the memory backstop, and the watchdog on
// either mismatch. The lease arm closes the capture race (RESIDUAL 2): a thief
// that stole our socket inside the bind→listening tick, which the inode arm
// cannot see because we captured the thief's inode, is caught the moment the
// thief writes its own pid into the lease. No parallel exit path.
function armOwnershipWatch(sockPath: string, bound: SocketIdentity): void {
  makeOwnershipWatch({
    bound,
    myPid: process.pid,
    readIdentity: () => readSocketIdentity(sockPath),
    readLease: () => readLease(leasePathFor(sockPath)),
    shutdown: (code) => shutdown(code),
    log: dlog,
  }).arm();
}

// --- self-shutdown on RSS / age ---
let limits: LimitsHandle | null = null;
// [LAW:no-ambient-temporal-coupling] Whatever serves requests establishes the
// limits before the first one: runDaemon before it binds, the page that runs
// the daemon (site/transport.ts) as it loads. A request before them would be a
// boot-order bug, said here rather than answered with a guess.
function establishedLimits(): LimitsHandle {
  if (limits === null) throw new Error("daemon: limits not yet established");
  return limits;
}
// Parses the budget from `env` — throwing on a malformed override — and builds
// the limits. Building starts nothing: only the daemon that won the socket
// arms them (onListening), so the page answers the doctor's `serving` with no
// timer counting its memory.
export function establishLimits(env: NodeJS.ProcessEnv): void {
  budgetBytes = memoryLimitBytes(env);
  limits = makeLimits(
    realLimitsDeps(stats.startedAt.getTime(), (code) => shutdown(code), {
      limitBytes: budgetBytes,
    }),
  );
}

// --- socket-ownership lease ---
//
// [LAW:one-source-of-truth] The lease is the authority for socket ownership —
// its owner pid + kill(pid,0) is what the next daemon's EADDRINUSE arbitration
// consults (handleAddressInUse). Exclusion RIGHT NOW is still the atomic bind()
// in bindOrAttachAndExit(); the lease answers the separate question "may I
// destroy this existing path" over time. It also carries the same diagnostic
// fields the old pidfile did, so one file serves both roles.
//
// Overwrite-on-write (no EEXIST check). We only reach onListening after winning
// the bind, so whatever stale lease a dead owner left is ours to replace. Write
// failure is non-fatal: the lease is best-effort ownership signalling on top of
// bind()'s hard exclusion; a missing lease degrades a future arbitration to
// "reclaim" (unlink + rebind), never to a wrong attach.

function writeLeaseFile(sockPath: string): void {
  const reason = writeLease(leasePathFor(sockPath), {
    pid: process.pid,
    version: PROTOCOL_VERSION,
    binPath: process.argv[1],
    startTime: myStartTime,
  });
  if (reason !== null) dlog("warn", `lease write failed: ${reason}`);
}

let inFlight = 0;

// --- shutdown ---

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // [LAW:single-enforcer] Arm the SIGKILL backstop FIRST, before any cleanup.
  // The 452-daemon incident: shut-down daemons logged "shutting down" but
  // held the bound socket FD 42 minutes later — process.exit() reached the
  // call site but never completed because some active handle kept libuv's
  // event loop alive past exit's teardown. The prior shape had `.unref()`
  // on the SIGKILL timer, so the timer itself did NOT keep the loop alive
  // — leaving the loop's only remaining live handles to win the race.
  //
  // What this timer guarantees: as long as the event loop can still run
  // (handles that won't drop, async cleanup that schedules but never
  // completes — the realistic failure modes for the incident class), the
  // setTimeout callback fires within 500ms and SIGKILL terminates the
  // process from outside the loop's bookkeeping. Critically the timer is
  // NOT unref'd, so it is itself an active handle that keeps the loop
  // alive long enough for itself to fire.
  //
  // What this timer cannot do: rescue a truly synchronous thread block
  // (a C++ binding that never returns to JS, an infinite sync loop). No
  // JS timer can fire while the main thread is blocked; only an external
  // signal recovers that case. The realistic 452-corpse mode was async-
  // handle retention, not a synchronous block, so the backstop is
  // load-bearing for the observed failure pattern.
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
  // [LAW:single-enforcer] The atomic bind() on the unix socket path is the
  // ONLY mutex preventing duplicate daemons. The previous shape unlinked
  // the socket file FIRST, then spent O(100ms) closing watchers, flushing
  // session state, and tearing down log streams before process.exit().
  // The unlink frees the path the instant it runs; the listening FD stays
  // held only until process.exit. In between, Claude Code's next render
  // tick can spawn a fresh daemon that bind()s the same path and starts
  // serving while we are still finishing cleanup. Under OOM cycles the
  // overlap compounds — 12 daemons stacked up in the wild was the
  // observed symptom. Do NOT unlink here. The kernel releases the FD on
  // process.exit; the stale path that remains is recovered by the
  // existing handleAddressInUse logic on the next daemon's startup
  // (probe → dead → unlink + rebind, ~50ms one-shot cost).
  // [LAW:no-silent-failure][LAW:dataflow-not-control-flow] Every teardown step
  // runs, each in order, and one that throws is logged by name without
  // skipping the rest: the session state still flushes after a close failed.
  const teardown: ReadonlyArray<readonly [string, () => void]> = [
    // [LAW:single-enforcer] Every tmux status line this daemon laid out is put
    // back before it goes (src/daemon/tmux-status.ts).
    ["tmuxStatusLines restore", () => tmuxStatusLines.restoreAll()],
    ["gitService close", () => gitService.close()],
    ["usageStore close", () => usageStore.close()],
    ["tmuxService close", () => tmuxService.close()],
    ["hostService close", () => hostService.close()],
    // Before the storage it resumes: an aborted run resumes its sources once
    // its program is gone.
    ["runs close", () => runs.close()],
    ["managedStorage close", () => managedStorage.close()],
    ["watcherRegistry close", () => watcherRegistry.closeAll()],
    ["sessionState flush", () => sessionState.flush()],
  ];
  for (const [step, run] of teardown) {
    try {
      run();
    } catch (e) {
      dlog("warn", `${step} failed: ${(e as Error).message}`);
    }
  }
  // [LAW:one-source-of-truth] Remove the lease only if it still names us. A
  // displaced daemon (socket stolen, thief wrote its own lease) must not delete
  // the live owner's lease on its way out, or the next EADDRINUSE would read
  // `absent` and reclaim the thief's live socket — cascading the theft.
  removeLeaseIfOwned(leasePath(), process.pid);
  // [LAW:one-source-of-truth] Same "only if it still names us" guard as the
  // lease above, reused via releaseRegistration — a slot this daemon never
  // claimed (exempt production, or refused before claiming one) is null and
  // skipped.
  if (breakerRegistryPath !== null) {
    releaseRegistration(
      breakerRegistryPath,
      process.pid,
      readRegistryEntry,
      (p) => fs.unlinkSync(p),
    );
  }
  // The log writes every line still waiting as the process exits (log.ts), so
  // the death line lands without a flush here.
  process.exit(code);
}

// --- per-connection handler ---

function handleConnection(sock: net.Socket): void {
  // [LAW:effects-at-boundaries] When the connection was accepted, on the
  // monotonic clock: a render says how long it waited from here to begin.
  const accepted = performance.now();
  inFlight++;
  stats.inFlight = inFlight;
  let responded = false;
  // A connection is in flight until it is answered and closes, or until it
  // becomes a subscription, which daemon-stats counts as one of
  // `frameFeeds.subscribers` instead.
  let counted = true;
  const leaveInFlight = (): void => {
    if (!counted) return;
    counted = false;
    inFlight = Math.max(0, inFlight - 1);
    stats.inFlight = inFlight;
  };

  // [LAW:no-ambient-temporal-coupling] respond owns the response→exit
  // ordering. exitAfterFlush (an exit code; null = stay up) is performed
  // by sock.end's completion callback, which Node invokes on 'finish' OR
  // 'error' — a total signal. A peer that vanished mid-flush still settles,
  // so the exit wish can never be stranded on a dead socket, and a live
  // peer always has the frame in the kernel buffer before process.exit
  // (unix-socket data survives writer exit). No fixed sleep stands between
  // respond and exit; the SIGKILL backstop inside shutdown() is the
  // unrelated last-resort safety.
  const respond = (
    resp: Response,
    exitAfterFlush: number | null,
    delivered: () => void,
  ): void => {
    if (responded) {
      // First responder owns the flush. Reaching here with an exit wish is
      // unreachable today (both exit-carrying arms resolve synchronously,
      // far inside the request timeout) — but if it ever happens, say so
      // instead of silently leaving a daemon up that was told to exit.
      // [LAW:no-silent-failure]
      if (exitAfterFlush !== null) {
        dlog(
          "warn",
          "exit-after-flush dropped: an earlier responder settled this socket",
        );
      }
      return;
    }
    responded = true;
    const settle =
      exitAfterFlush === null
        ? undefined
        : (): void => shutdown(exitAfterFlush);
    try {
      // A peer that already left fails the flush (it ended its side), so a
      // clean one is the client holding the response.
      sock.end(encodeFrame(resp), (err?: Error | null) => {
        if (err == null) delivered();
        settle?.();
      });
    } catch (e) {
      // [LAW:no-silent-failure] The response is lost (socket already torn
      // down), but the exit wish must not be.
      dlog("warn", `response write failed: ${(e as Error).message}`);
      settle?.();
    }
  };

  // Per-request timeout protects the daemon from a single slow request
  // (e.g. a hung git call) blocking subsequent connections. It abandons the
  // RESPONSE, not the work — the handler promise keeps running.
  //
  // [LAW:one-source-of-truth] That is safe for the transcript-fs path because
  // the work is bounded + shared, not orphaned: the today aggregate and
  // per-session usage compute behind a SingleFlight (src/utils/single-flight.ts),
  // so a timed-out render that abandoned its await leaves behind the ONE
  // canonical in-flight scan, which the next render coalesces onto rather than
  // duplicating. A timeout therefore adds zero new fs work — there is never
  // more than one scan per key to orphan. Cancellation would be both messier
  // and wasteful here (the in-flight scan is exactly what the next tick needs).
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stats.requestsTimedOut++;
    respond(
      {
        ok: false,
        error: `request exceeded ${REQUEST_TIMEOUT_MS}ms`,
        code: "TIMEOUT",
        daemonV: PROTOCOL_VERSION,
      },
      null,
      NOTHING_DELIVERED,
    );
  }, REQUEST_TIMEOUT_MS);

  const reader = makeFrameReader(
    (frame) => {
      void handleRequest(frame as Request, () => timedOut, accepted)
        .then((r) =>
          r.kind === "reply"
            ? respond(r.resp, r.exitAfterFlush, r.delivered)
            : stream(r.sessionId, r.lane),
        )
        .catch((err: unknown) => {
          dlog("error", `handler threw: ${inspect(err)}`);
          respond(renderFailed(err), null, NOTHING_DELIVERED);
        });
    },
    (err) => {
      dlog("warn", `frame parse failed: ${err.message}`);
      respond(
        {
          ok: false,
          error: err.message,
          code: "BAD_REQUEST",
          daemonV: PROTOCOL_VERSION,
        },
        null,
        NOTHING_DELIVERED,
      );
    },
  );

  // The connection becomes the session's subscription: no reply, no request
  // timeout, and frames until the subscriber closes it. It carries frames one
  // way only, so anything more the subscriber sends is not read.
  // [LAW:no-ambient-temporal-coupling] A subscriber slower than the frames
  // gets the newest one when its socket drains, never a backlog of stale ones.
  const stream = (sessionId: string, lane: Lane): void => {
    // A connection the request timer already answered — TIMEOUT, then ended, while a cold or busy
    // daemon had not yet read the subscribe — is not a subscription: its socket is closing, and a
    // feed attached to it would never hear the close. The subscriber was told, and opens another.
    if (responded) return;
    // A subscriber that hung up before its subscribe was handled: its close has
    // already fired, so a feed attached now would never hear it.
    if (sock.destroyed) return;
    clearTimeout(timer);
    leaveInFlight();
    sock.off("data", reader);
    const write = newestWins(sock);
    const unsubscribe = frameFeeds.subscribe(sessionId, {
      lane,
      frame: (resp, json) =>
        write(encodeJsonFrame(LANE_FRAMES[lane](resp, json))),
      // A refused subscription is over: its refusal ends the stream, and a
      // frame still waiting for the socket to drain is dropped, as
      // newest-wins drops any frame a newer one replaces.
      refused: (resp) => sock.end(encodeFrame(resp)),
      drawing: () => true,
    });
    // Answered only once the subscription stands: a subscribe that threw is
    // the connection's `handler threw`, answered RENDER_FAILED and ended,
    // never an open socket nothing feeds.
    responded = true;
    sock.on("close", unsubscribe);
  };

  sock.on("data", reader);
  sock.on("error", (err) => {
    dlog("warn", `socket error: ${err.message}`);
  });
  sock.on("close", () => {
    clearTimeout(timer);
    leaveInFlight();
  });
}

// [LAW:no-ambient-temporal-coupling] A request whose semantics include "then
// exit" (the shutdown verb, the stale-binary version mismatch) must not exit
// until its response has flushed — but handleRequest cannot see the socket.
// So the exit is returned as DATA (the exit code; null = stay up) and the
// connection boundary, which owns the flush, sequences shutdown on the write
// completion. No timer stands between respond and exit.
// [LAW:effects-at-boundaries] handleRequest computes the description; the
// socket boundary performs it.
export interface Reply {
  readonly resp: Response;
  readonly exitAfterFlush: number | null;
  // [LAW:effects-at-boundaries] What the reply's sender records once the
  // client holds the response — only the connection knows when that is: a
  // render whose answer carried a click error marks it answered.
  readonly delivered: () => void;
}
const NOTHING_DELIVERED = (): void => {};
// A subscription is the one request answered by a stream rather than a reply:
// the connection boundary turns its socket over to the session's feed.
type HandledRequest =
  | ({ kind: "reply" } & Reply)
  | { kind: "subscribe"; sessionId: SessionId; lane: Lane };

const stay = (resp: Response): Reply => ({
  resp,
  exitAfterFlush: null,
  delivered: NOTHING_DELIVERED,
});
const replied = (reply: Reply): HandledRequest => ({ kind: "reply", ...reply });

// [LAW:types-are-the-program] Every request kind answered with a reply: all
// but a subscribe, the compiler naming one added to the protocol until it is.
type ReplyRequest = Exclude<Request, SubscribeRequest>;
const REPLY_KINDS: Readonly<Record<ReplyRequest["kind"], true>> = {
  render: true,
  "pane-session": true,
  shutdown: true,
  stats: true,
  click: true,
  debug: true,
};

// [LAW:single-enforcer] The one reply to a request whose handler threw — a
// render's own throw, or any other handler's that reached the connection.
const renderFailed = (err: unknown): Response => ({
  ok: false,
  error: err instanceof Error ? err.message : inspect(err),
  code: "RENDER_FAILED",
  daemonV: PROTOCOL_VERSION,
});

// [LAW:single-enforcer] The checkpoint's one refusal: the request is
// answered, never streamed, and the connection stays up.
const refuse = (
  code: "BAD_REQUEST" | "VERSION_MISMATCH",
  error: string,
): HandledRequest =>
  replied(stay({ ok: false, error, code, daemonV: PROTOCOL_VERSION }));

// A subscribe past the connection's checkpoint: the subscription it opens, or
// the reply refusing it.
// [LAW:parse-dont-validate] Trust boundary: the session id and the lane are
// untrusted JSON; the id keys the feed and the lane is what its toggle gates.
function subscription(req: SubscribeRequest): HandledRequest {
  const sessionId = parseSessionId(req.sessionId);
  if (!sessionId.ok)
    return refuse("BAD_REQUEST", `subscribe's sessionId ${sessionId.problem}`);
  // A subscribe that names no lane speaks the contract from before the
  // lane toggles: VERSION_MISMATCH, which every older client reads as "this
  // client is out of date" and stops on, rather than BAD_REQUEST, which it
  // reads as a daemon too old to take subscribe and retries forever.
  if (req.lane === undefined)
    return refuse(
      "VERSION_MISMATCH",
      `this client's subscribe names no lane (${LANE_NAMES.join(", ")}): it predates the lane toggles — update it`,
    );
  const lane = parseLane(req.lane);
  if (lane === null)
    return refuse(
      "BAD_REQUEST",
      `subscribe needs a lane, one of ${LANE_NAMES.join(", ")}: got ${JSON.stringify(req.lane)}`,
    );
  return { kind: "subscribe", sessionId: sessionId.id, lane };
}

export async function handleRequest(
  req: Request,
  timedOut: () => boolean,
  accepted: number,
): Promise<HandledRequest> {
  if (
    !req ||
    typeof req !== "object" ||
    typeof (req as Request).v !== "number"
  ) {
    return refuse("BAD_REQUEST", "malformed request");
  }

  if (req.v !== PROTOCOL_VERSION) {
    // [LAW:types-are-the-program] The asymmetry is data, not control flow.
    //   client > daemon: the *binary* probably upgraded under us. Exit so the
    //     next client respawns from the current artifact.
    //   client < daemon: the *client* is stale. Respawning daemon does not
    //     help (the new daemon will have the same version). Stay up and
    //     return VERSION_MISMATCH — the client is responsible for surfacing
    //     the diagnostic and refusing to kick. Shutting down here was the
    //     load-bearing half of the 452-corpse spiral (kz8.5).
    if (req.v > PROTOCOL_VERSION) {
      dlog(
        "info",
        `version mismatch: client=${req.v} > daemon=${PROTOCOL_VERSION}; binary likely upgraded — exiting after the response flushes`,
      );
    } else {
      dlog(
        "info",
        `version mismatch: client=${req.v} < daemon=${PROTOCOL_VERSION}; client is stale — staying up`,
      );
    }
    return {
      kind: "reply",
      resp: {
        ok: false,
        error: `protocol v${req.v} not supported (daemon at v${PROTOCOL_VERSION})`,
        code: "VERSION_MISMATCH",
        daemonV: PROTOCOL_VERSION,
      },
      // [LAW:dataflow-not-control-flow] The asymmetry above is this value.
      // Exit is sequenced on the response flush, so the client always sees
      // the VERSION_MISMATCH diagnostic — never a dead socket.
      exitAfterFlush: req.v > PROTOCOL_VERSION ? 0 : null,
      delivered: NOTHING_DELIVERED,
    };
  }

  if (req.kind === "subscribe") return subscription(req);
  // [LAW:parse-dont-validate] The kind is untrusted JSON: one no request
  // carries — a name no kind has, or no name at all, which `Object.hasOwn`
  // would coerce into one — is refused here, so replyTo is total over the
  // kinds it is typed for.
  if (typeof req.kind !== "string" || !Object.hasOwn(REPLY_KINDS, req.kind))
    return refuse("BAD_REQUEST", "unknown kind");
  return replied(await replyTo(req, timedOut, accepted));
}

// The reply to a request of any kind but a subscribe, past the connection's
// checkpoint. The site (site/transport.ts) calls it with requests it built.
export async function replyTo(
  req: ReplyRequest,
  timedOut: () => boolean,
  accepted: number,
): Promise<Reply> {
  if (req.kind === "shutdown") {
    return {
      resp: { ok: true, output: "" },
      exitAfterFlush: 0,
      delivered: NOTHING_DELIVERED,
    };
  }

  if (req.kind === "pane-session") {
    // [LAW:parse-dont-validate] Trust boundary: both are untrusted JSON.
    const { socket, pane } = req as { socket: unknown; pane: unknown };
    if (typeof socket !== "string" || typeof pane !== "string")
      return stay({
        ok: false,
        error: "pane-session needs a string socket and pane",
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
    return stay({
      ok: true,
      paneSession: frameFeeds.newestWhere(
        ({ hints: { tmux } }) =>
          tmux !== null &&
          tmux !== undefined &&
          tmux.socket === socket &&
          tmux.pane === pane,
      ),
    });
  }

  if (req.kind === "stats") {
    // [LAW:single-enforcer] Stats requests do NOT bump request counters —
    // observability shouldn't pollute the metric being observed.
    return stay({
      ok: true,
      stats: stats.snapshot({
        gitCache: gitService.getStats(),
        usageCache: usageStore.getStats(),
        sources: sourceSnapshots(),
        runs: runs.stats(),
        transcriptReads: transcriptReads(),
        renderCache: renderCache.stats,
        effectCache: effectSessions.getStats(),
        menuIdle: menuIdle.getStats(),
        sessionState: {
          sessions: sessionState.size(),
          observers: sessionState.observers(),
          revision: sessionState.latestRevision(),
        },
        frameFeeds: frameFeeds.getStats(),
        tmuxStatus: tmuxStatusLines.stats(),
        watchersActive: watcherRegistry.size(),
        nextRestartReason: establishedLimits().describeNextRestart(),
        handlerProbes: handlerProbes.list(),
        clients: renderSightings.list(instantOf(new Date())),
        bundle: DAEMON_BUNDLE,
        daemon: establishedLimits().serving(),
        doctorStores: readStores(DOCTOR_STORES),
      }),
    });
  }

  if (req.kind === "render") {
    // [LAW:effects-at-boundaries] The render request's two clock reads: the
    // instant the bar is drawn at (every time read in the render reads it),
    // and the monotonic start its wait and duration are measured from, so a
    // clock stepped meanwhile moves neither.
    const started = new Date();
    const at = instantOf(started);
    const t0 = performance.now();
    const queuedMs = Math.round(t0 - accepted);
    // [LAW:nothing-unseen] One render event per render request, written here
    // on every exit — a refusal and a throw included — from the facts the
    // render reached, so a failing render is described like any other.
    // A throw is this request's own RENDER_FAILED reply, so the event is the
    // one record of it and the connection's catch never sees a render.
    const facts: RequestFacts = [];
    // Where this request came in the order they arrived: renders of one session
    // can finish out of it.
    // [LAW:one-source-of-truth] The count of render requests received is that
    // order.
    const order = ++stats.requestsTotal;
    const checked = checkRenderRequest(req);
    // [LAW:single-enforcer] A render REQUEST is a client sighting — the
    // frames a feed draws from a session's data are not, so this is the one
    // write, here rather than in drawRender. It is written as the request
    // arrives, `drawing`, and again once its render settles, carrying what the
    // frame drew — both stamped with the instant and order it arrived in.
    const sighted = (req: CheckedRenderRequest, frame: FrameSeen): void =>
      renderSightings.see(
        req.sessionId,
        {
          client: req.hints.client ?? null,
          termCols: req.hints.termCols ?? null,
          rateLimits: req.rateLimits,
          claudeConfigDir: claudeConfigDir(req.hints.claudeConfigDir),
          projectDir: req.requested.projectDir,
          transcript: transcriptSaid(req.hookData),
          frame,
        },
        at,
        order,
      );
    if (checked.ok) {
      sighted(checked.req, "drawing");
      // [LAW:one-source-of-truth] A request past the checkpoint is the
      // session's data from now on; a followed session's next frame is drawn
      // from it, brought forward as its view takes it up. Its answer is its
      // own client's, drawn for a request, and never a frame
      // (src/daemon/frame-feed.ts).
      frameFeeds.note(checked.req.sessionId, checked.req, order);
    }
    // [LAW:no-ambient-temporal-coupling] When the request's wait ends, fixed
    // at its arrival: early enough before its client hangs up to draw
    // (src/daemon/request-deadline.ts).
    const waitFor = (req: CheckedRenderRequest): RequestWait => {
      const ms = waitBudgetMs(req.deadline, accepted, {
        epochMs: started.getTime(),
        monoMs: t0,
      });
      return { stated: req.deadline.kind, ms, endsAt: t0 + ms };
    };
    const rendered: {
      outcome: RequestOutcome;
      resp: Response;
      delivered: () => void;
    } = !checked.ok
      ? refusedRender(checked.problems)
      : await answerRequest(checked.req, at, waitFor(checked.req), facts).then(
          ({ answer, motion, clickShown }) => {
            sighted(checked.req, motion);
            return {
              outcome: { kind: "ok" } as const,
              resp: { ok: true, output: answer } as const,
              // [LAW:single-enforcer] An answer carrying the click error that
              // reaches its client is the one that delivered it
              // (src/daemon/click-error.ts).
              delivered:
                clickShown === null
                  ? NOTHING_DELIVERED
                  : () =>
                      answeredClickError(
                        sessionState,
                        checked.req.sessionId,
                        clickShown,
                      ),
            };
          },
          (error: unknown) => {
            sighted(checked.req, "failed");
            return {
              outcome: { kind: "threw", error } as const,
              resp: renderFailed(error),
              delivered: NOTHING_DELIVERED,
            };
          },
        );
    if (rendered.outcome.kind !== "ok") stats.requestsErrored++;
    // Whether the client was already told TIMEOUT while this render ran on,
    // and how long the request was queued, from the connection's accept,
    // before it began: the daemon's own delay and the client's sending of its
    // frame both count, so a round trip longer than `took` is time spent
    // there.
    noteFacts(facts, {
      timedOut: timedOut() ? "Y" : "N",
      queued: `${queuedMs}ms`,
    });
    const { level, line } = requestEvent(
      "render",
      facts,
      rendered.outcome,
      Math.round(performance.now() - t0),
    );
    dlog(level, line);
    return {
      resp: rendered.resp,
      exitAfterFlush: null,
      delivered: rendered.delivered,
    };
  }

  if (req.kind === "click") {
    // [LAW:nothing-unseen] One click event per click request, whatever its
    // outcome: how long it was queued behind the loop from its accept, how
    // long it then took, and what it learned on the way (a status-line
    // click's link, the verb that ran, its session). A field absent means it
    // stopped before it.
    const t0 = performance.now();
    const facts: RequestFacts = [["queued", `${Math.round(t0 - accepted)}ms`]];
    const outcome = clickOutcome(req, facts);
    // Whether the client was already told TIMEOUT while the click waited or
    // ran: its effect still lands, and the client reported a failure.
    noteFacts(facts, { timedOut: timedOut() ? "Y" : "N" });
    const { level, line } = requestEvent(
      "click",
      facts,
      outcome,
      Math.round(performance.now() - t0),
    );
    dlog(level, line);
    return stay(clickReply(outcome));
  }

  if (req.kind === "debug") {
    // [LAW:single-enforcer] One trust-boundary check at the wire edge —
    // `what` is untrusted JSON. isDebugWhat narrows it to the discriminated
    // union the introspector consumes; an invalid value short-circuits
    // here, not deep inside buildDebugSnapshot.
    if (!isDebugWhat(req.what)) {
      return stay({
        ok: false,
        // [LAW:no-silent-failure] Include the allowed values so a
        // CLI consumer (or operator) sees what is supported without
        // grep — same pattern as the set-state verb's unknown-key error
        // in src/daemon/verbs/state-validators.ts.
        error: `unknown debug 'what': ${String(req.what)} (have: ${DEBUG_WHATS.join(", ")})`,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
    }
    // [LAW:dataflow-not-control-flow] The debug projection samples whatever
    // DSL state the cache currently holds. With cache keys scoped on
    // (projectDir, cwd) and the debug request carrying neither, we sample
    // the most recently rendered session's view — sufficient for `debug vars`,
    // `debug segments`, `debug config` against the active workload.
    // latestView reads existing views only; it does NOT open one,
    // so debug introspection never has the side effect of standing up a new
    // (projectDir=undefined) cache entry tied to the daemon's own
    // process.cwd(). A future debug-target selector would thread (session,
    // projectDir, cwd) through the wire.
    const dbgView = renderCache.latestView();
    // [LAW:dataflow-not-control-flow] Lazy per-segment serialization: the
    // cache stores StripCell arrays (cheap, written by renderDsl).
    // The debug projection needs strings, so serialize only for the
    // `segments` projection (`vars` and `config` don't need it) and only
    // when this request actually fires. Normal renders pay no per-segment
    // serializer cost — that work shifts to debug-request time, which is
    // operator-driven and rare.
    const dbgState =
      dbgView === null
        ? null
        : {
            store: dbgView.store,
            registry: dbgView.registry,
            config: dbgView.state.config,
            compiled: dbgView.state.compiled,
            lastRenderBySegment:
              req.what === "segments"
                ? serializeSegmentCells(
                    dbgView.lastRenderCellsBySegment,
                    dbgView.state.config.globals.colorCompatibility ??
                      floorOf("colorCompatibility"),
                  )
                : EMPTY_RENDER_MAP,
          };
    return stay({ ok: true, debug: buildDebugSnapshot(req.what, dbgState) });
  }

  const unanswered: never = req;
  throw new Error(`no reply for request ${inspect(unanswered)}`);
}

// [LAW:single-enforcer][LAW:no-silent-failure] Parse render-path args with
// the standard util at the trust boundary. `--config <path>` is the sole
// valid render flag; every other flag, a `--config` with no path after it,
// and a positional word are refused arguments the caller shows as the bar's
// error and on the render event.
// The `--config` value crosses `explicitConfigPath` against the CLIENT's cwd
// (the request's, brandon-config-nuq6), the rule the client applies to its
// `configEnv` hint: empty is no override, `~` is expanded once, here.
//
// `tokens: true, strict: false, allowPositionals: true` together let the
// parser emit a token entry for every flag (known or unknown) without
// throwing on unknown ones, and without mis-classifying their values as
// positionals. Not strict, `--config` takes whatever follows it as its
// value, so only the last token can be a bare `--config`, and being last it
// is the one that wins.
function parseRenderArgs(
  args: string[],
  cwd: string,
): {
  configFile: string | undefined;
  refusedArgs: readonly RefusedArg[];
} {
  const { tokens } = parseArgs({
    args: args.slice(1), // skip binary path
    options: { config: { type: "string" } },
    strict: false,
    tokens: true,
    allowPositionals: true,
  });
  // [LAW:one-source-of-truth] The last `--config` decides both the path and
  // whether it is refused, so the two cannot disagree.
  const config = (tokens ?? [])
    .filter(
      (t): t is Extract<typeof t, { kind: "option" }> =>
        t.kind === "option" && t.name === "config",
    )
    .at(-1);
  const refused = (tokens ?? []).flatMap((t): RefusedArg[] => {
    switch (t.kind) {
      case "option":
        return t.name !== "config"
          ? [{ arg: t.rawName, why: "unknown" }]
          : t === config && t.value === undefined
            ? [{ arg: t.rawName, why: "no-value" }]
            : [];
      case "positional":
        return [{ arg: t.value, why: "positional" }];
      // `--` only ends the flags; the words after it are positionals.
      case "option-terminator":
        return [];
    }
  });
  return {
    configFile: explicitConfigPath(cwd, config?.value),
    // In argv order, each refusal once.
    refusedArgs: refused.filter(
      (r, i) =>
        refused.findIndex((o) => o.arg === r.arg && o.why === r.why) === i,
    ),
  };
}

// --- click verb dispatch ---
// [LAW:dataflow-not-control-flow] The dispatcher is a table lookup. The verb
// table (src/daemon/verbs/index.ts) is the single canonical list of supported
// verbs — handlers live there, the dispatcher only routes.
//
// [LAW:types-are-the-program] The error class on the throw determines the
// response code: BadVerbArgs (invalid input shape) becomes BAD_REQUEST; any
// other Error (operational failure) becomes RENDER_FAILED. No string matching.

const verbCtx = {
  sessionState,
  dlog,
  applyUpdate: () => updateWatch.act(),
  // The load the session's bar is drawn from: its cache entry's load
  // outcome, and what the config that entry renders left unused.
  // [LAW:no-ambient-temporal-coupling] Reloaded first, as a save does: a
  // doctor click is a verdict on the files as they are now, not on
  // whether the fs watcher has caught up with an edit made a moment ago.
  doctor: productionEdge((origin) => {
    const at = [
      origin.projectDir,
      origin.cwd,
      origin.configFile ?? undefined,
    ] as const;
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
  doctorStores: DOCTOR_STORES,
  probes: handlerProbes,
  clients: renderSightings,
  bundle: DAEMON_BUNDLE,
  serving: () => establishedLimits().serving(),
  claudeInput: productionClaudeInputEdge(),
  history: settingsHistory,
  navigation: navigationHistory,
  // The config a session's last render resolved from — the same entry the
  // render drew the bar with, so a save compares against the bar the user saw.
  configFor: (origin: RenderOrigin) =>
    renderCache.getOrCreate(
      origin.projectDir,
      origin.cwd,
      origin.configFile ?? undefined,
    ).state.config,
  reloadConfig: (origin: RenderOrigin) =>
    renderCache.reload(
      origin.projectDir,
      origin.cwd,
      origin.configFile ?? undefined,
      { kind: "write" },
    ),
  // The storage keys of the same entry `configFor` reads the config of.
  sourcesFor: (origin: RenderOrigin) =>
    renderCache.getOrCreate(
      origin.projectDir,
      origin.cwd,
      origin.configFile ?? undefined,
    ).state.sources,
  links: linkSigner,
  runs,
  lanes: { of: lanesAt, clicked: laneClicked },
  views: {
    follow: (sessionId: string, origin: RenderOrigin) =>
      renderCache.follow(
        sessionId,
        origin.projectDir,
        origin.cwd,
        origin.configFile ?? undefined,
      ),
  },
};

/**
 * Re-read the config a render origin resolves to, now: what a durable click
 * does after it writes. The page in site/, which runs this daemon in a browser,
 * calls it after it resets its simulated machine's config file.
 */
export const reloadConfig = verbCtx.reloadConfig;

// [LAW:single-enforcer] Style + color compatibility shared by the render
// path and the lazy debug-side per-segment serializer. Per-request `width`
// is composed on top at the wire boundary (replyTo's render arm) and
// passed through as renderOpts. Debug serialization composes its own
// per-segment opts with width: Number.POSITIVE_INFINITY since each segment
// is rendered standalone (wrap doesn't apply to a one-segment projection).
const RENDER_OPTS_BASE = {
  endcaps: floorOf("endcaps"),
  colorCompatibility: floorOf("colorCompatibility"),
  wrap: floorOf("autoWrap"),
  padding: floorOf("padding"),
};
const DEBUG_RENDER_OPTS: BuildLineOptions = {
  ...RENDER_OPTS_BASE,
  width: Number.POSITIVE_INFINITY,
};

// [LAW:no-defensive-null-guards] Reused empty map for the `vars` /
// `config` debug projections — they don't read lastRenderBySegment but
// the DaemonDslState type requires the field.
const EMPTY_RENDER_MAP = new Map<string, string>();

// [LAW:one-source-of-truth] The color depth is a serialization-time choice.
// A debug request carries no session, so the sampled entry's CONFIG values
// are the ones it can state — a session's own pick, like its endcaps, is not
// visible here. The caller threads the entry-resolved values; this
// serializer never re-defaults them.
function serializeSegmentCells(
  cells: ReadonlyMap<string, readonly RichText[]>,
  colorCompatibility: ColorCompatibility,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, segCells] of cells) {
    out.set(
      name,
      renderStripCells(segCells, {
        ...DEBUG_RENDER_OPTS,
        colorCompatibility,
      }),
    );
  }
  return out;
}

// [LAW:parse-dont-validate][LAW:no-silent-failure] A click request run to its
// outcome. Its verb and value are untrusted JSON, refused here unless both are
// strings, and whatever the click then throws is its outcome too, so every
// click writes its event: a refusal of its arguments is a bad request, and
// anything else thrown is the daemon's failure — a program the click ran, or
// a bug — recorded with the stack that says which.
function clickOutcome(req: ClickRequest, facts: RequestFacts): RequestOutcome {
  const { verb, value } = req as { verb: unknown; value: unknown };
  if (typeof verb !== "string" || typeof value !== "string") {
    return {
      kind: "bad-request",
      problems: [
        `a click's verb and value are strings, got ${typeof verb} and ${typeof value}`,
      ],
    };
  }
  try {
    return handleClick(
      verb,
      value,
      { via: "link", handler: sanitizeClientVersion(req.clientVersion) },
      facts,
    );
  } catch (error) {
    return error instanceof BadVerbArgs
      ? { kind: "bad-request", problems: [error.message] }
      : { kind: "threw", error };
  }
}

// [LAW:dataflow-not-control-flow] The field a click records the verb it runs
// under, by how it arrived: a status-line click has already recorded its own
// verb, so the one its link runs is `linkVerb`.
const VERB_FACT: Readonly<Record<ClickArrival["via"], string>> = {
  link: "verb",
  "tmux-status": "linkVerb",
};

function handleClick(
  verb: string,
  value: string,
  arrival: ClickArrival,
  facts: RequestFacts,
): RequestOutcome {
  if (verb === VERB_TMUX_STATUS_CLICK) {
    noteFacts(facts, { verb });
    return statusLineClick(value, facts);
  }
  const handler = VERBS.get(verb);
  if (!handler) {
    return { kind: "bad-request", problems: [`unknown click verb: ${verb}`] };
  }
  noteFacts(facts, { [VERB_FACT[arrival.via]]: verb });
  // The click's session, as it crossed the one session-id checkpoint: one
  // that passed is recorded and restarts its idle clock, one that failed is
  // never recorded, and a click naming none records `sid=-`.
  const session = clickSessionOf(verb, value);
  if (session === null) noteFacts(facts, { sid: "-" });
  else if (session.ok) {
    noteFacts(facts, { sid: session.id });
    menuIdle.clicked(session.id, instantOf(new Date()));
  }
  handler(value, { ...verbCtx, arrival });
  return { kind: "ok" };
}

// [LAW:single-enforcer] The reply a click's outcome is answered with.
function clickReply(outcome: RequestOutcome): Response {
  switch (outcome.kind) {
    case "ok":
      return { ok: true, output: "" };
    case "bad-request":
      return {
        ok: false,
        error: outcome.problems.join("; "),
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      };
    case "threw":
      return renderFailed(outcome.error);
  }
}

// A click in a tmux status line: the link the daemon's frame marks that range
// with, run as a click on it in the bar would run — a `cc-candybar://` link
// through its own verb, any other through the platform's opener. Its verb
// is told the click came through tmux, not the URL handler.
function statusLineClick(value: string, facts: RequestFacts): RequestOutcome {
  const refused = (problem: string): RequestOutcome => ({
    kind: "bad-request",
    problems: [problem],
  });
  const click = tmuxStatusLines.linkAt(value);
  if (click.kind === "refused") return refused(click.reason);
  noteFacts(facts, { link: click.url });
  if (click.url.startsWith("cc-candybar://")) {
    // A link a config wrote with a malformed escape is refused, as any
    // click's malformed wire encoding is.
    const parsed = decodeWire(() => parseHandlerUrl(click.url));
    // [LAW:no-silent-failure] A link the bar draws never names this verb; one
    // that did would be a click that only ever clicks another.
    if (parsed.verb === VERB_TMUX_STATUS_CLICK)
      return refused("a status-line link names another status-line click");
    return handleClick(
      parsed.verb,
      parsed.value,
      { via: "tmux-status" },
      facts,
    );
  }
  clickLaunch(
    {
      bin: process.platform === "darwin" ? "/usr/bin/open" : "xdg-open",
      args: [click.url],
      category: "click.open",
    },
    `opening ${click.url}`,
    dlog,
  );
  return { kind: "ok" };
}

// --- render ---

// One frame of a subscribed session, drawn from its latest request at this
// instant, by the render a request gets. The response is the one that request
// would be answered with, and the bar moves when its effects say it does.
// [LAW:parse-dont-validate] The request the session's view is declared with
// crossed the checkpoint when it arrived, so a frame draws by it without
// asking again. Null while the session has no view: a frame opens none.
// [LAW:nothing-unseen] A frame that throws carries the render event a throwing
// request writes, for the feed to log when that failure is first pushed; the
// feed summarizes the frames that render.
// [LAW:effects-at-boundaries] Synchronous by type: a frame reads every value
// as its owner stored it (the view's payload), so it performs no I/O and
// refreshes no source — the request it is drawn from made those refreshes,
// and an event, never a frame, opened the view it draws.
function renderFrame(sessionId: string, fps: number): FeedFrame | null {
  const started = new Date();
  const at = instantOf(started);
  const facts: RequestFacts = [];
  try {
    using setup = setUpFrame(sessionId, at, facts);
    if (setup === null) return null;
    const { drawn, motion, evaluated, lanes } = drawRender(setup, {
      by: "feed",
      fps,
    });
    const output = composeBar(drawn);
    return {
      at,
      resp: { ok: true, output },
      statusline: {
        ok: true,
        output: statuslineOf(
          sessionId,
          drawn,
          output,
          handedOffTo(lanes, frameFeeds.following(sessionId)),
        ),
      },
      moves: motion === "moves",
      evaluated,
      failure: null,
    };
  } catch (error) {
    const outcome = { kind: "threw", error } as const;
    const { level, line } = requestEvent(
      "render",
      facts,
      outcome,
      Date.now() - started.getTime(),
    );
    const failed = renderFailed(error);
    return {
      at,
      resp: failed,
      statusline: failed,
      moves: false,
      evaluated: 0,
      failure: { level, line: `frame ${line}` },
    };
  }
}

// [LAW:one-source-of-truth] A session's globals over the render state it
// draws with: the one resolution a render draws by and the lane gate reads.
// `.preset.customized` reads THIS state's authoredRoots — the set computed
// from the SAME raw parse that produced state.config, on the same reload —
// never a fresh file read that could race a concurrent write and disagree with
// the tree that actually rendered.
function sessionGlobals(
  sessionId: string,
  state: DslRenderState,
): EffectiveGlobals {
  return resolveEffectiveGlobals(
    state.config,
    (key) => sessionState.get(sessionId, key),
    (preset) => state.authoredRoots.has(preset),
  );
}

// The lanes the session's settings switch on now, as its view draws them, or
// null while it has no view: a pure read of the view a frame finds, which
// opens nothing (`holdView`).
function viewLanes(sessionId: string): LaneSwitches | null {
  using hold = renderCache.holdView(sessionId);
  return hold === null ? null : laneSwitches(hold.view.source.effective());
}

// The lanes `sessionId`'s settings switch on over the config `origin`
// resolves to, as the render cache holds it.
function lanesAt(origin: RenderOrigin, sessionId: string): LaneSwitches {
  using hold = renderCache.hold(
    origin.projectDir,
    origin.cwd,
    origin.configFile ?? undefined,
  );
  return laneSwitches(sessionGlobals(sessionId, hold.state));
}

// A render request that crossed the checkpoint: its hookData carries every
// required field with its declared type, its cwd is absolute, `hints` is its
// client hints, parsed, and its args are parsed into `requested` — the config
// inputs it named, its explicit path the `--config` flag over the client's
// `CC_CANDYBAR_CONFIG` hint — and `refusedArgs`, `rateLimits` is
// what its hookData says of the rate-limit windows, and `deadline` is when its
// client hangs up. Raw `req.*` hint fields and `req.args` are not read past
// the checkpoint. Only checkRenderRequest makes one.
declare const CHECKED: unique symbol;
type CheckedRenderRequest = Omit<RenderRequest, "deadline"> & {
  readonly deadline: ClientDeadline;
  readonly sessionId: SessionId;
  readonly hints: ClientHints;
  readonly rateLimits: RateLimitsSeen;
  readonly requested: RenderOrigin;
  readonly refusedArgs: readonly RefusedArg[];
  readonly [CHECKED]: true;
};

// [LAW:parse-dont-validate] The checkpoint a render request crosses once: a
// checked request, or the problems that refuse it.
function checkRenderRequest(
  req: RenderRequest,
): { ok: true; req: CheckedRenderRequest } | { ok: false; problems: string[] } {
  // [LAW:single-enforcer] One trust-boundary check for incoming hookData.
  // The validator reports missing/wrong-typed required fields and unknown
  // top-level keys. Required-field problems are *protocol* failures
  // (Claude Code's schema guarantees these — their absence means the
  // sender is broken or malicious); unknown fields are advisory (Anthropic
  // may have added something).
  const { report } = validateHookData(req.hookData as unknown);
  // [LAW:no-silent-failure][LAW:types-are-the-program] Gate hard on
  // schema violations. Continuing with `workspace?.project_dir` would
  // collapse "absent" into an empty-string cache key — silently sharing
  // one entry across every malformed request — and downstream code would
  // have to defend against an empty projectDir forever. Reject here so
  // the types downstream carry the strongest true theorem: by the time
  // a cache entry is built, projectDir/cwd are real non-empty strings.
  const wireProblems: string[] = [];
  for (const path of report.missingRequired) {
    wireProblems.push(`missing required field '${path}'`);
  }
  for (const { path, expected, got } of report.typeMismatches) {
    wireProblems.push(`field '${path}' expected ${expected}, got ${got}`);
  }
  // [LAW:single-enforcer] The session id crosses the one session-id
  // checkpoint, as a subscribe's and a click's do.
  const sessionId = parseSessionId(req.hookData?.session_id);
  if (!sessionId.ok) {
    wireProblems.push(`field 'session_id' ${sessionId.problem}`);
  }
  // [LAW:parse-dont-validate] Absolute, not merely non-empty: the
  // request's cwd anchors a relative `--config` (parseRenderArgs), and a
  // relative anchor would resolve against the daemon's own cwd
  // (brandon-config-nuq6). Both clients send their process cwd.
  // The cwd is untrusted JSON too: a value that is not a string is refused
  // here, never handed to isAbsolute, which would throw past the render event.
  if (typeof req.cwd !== "string" || !isAbsolute(req.cwd)) {
    wireProblems.push(
      `request 'cwd' is not an absolute path: ${JSON.stringify(req.cwd)}`,
    );
  }
  // The args too: parseRenderArgs reads them below, outside the render's own
  // error path, so a value that is not a list of strings is refused here
  // rather than thrown past the render event.
  if (
    !Array.isArray(req.args) ||
    !(req.args as unknown[]).every((a) => typeof a === "string")
  ) {
    wireProblems.push(
      `request 'args' is not a list of strings: ${JSON.stringify(req.args)}`,
    );
  }
  const deadline = parseClientDeadline(
    (req as { deadline?: unknown }).deadline,
  );
  if (deadline.kind === "refused")
    return { ok: false, problems: [...wireProblems, deadline.problem] };
  if (wireProblems.length > 0 || !sessionId.ok)
    return { ok: false, problems: wireProblems };
  // [LAW:nothing-unseen] Said once per daemon, at its first sight: every
  // request carries the field, and a line each rotated the log in minutes.
  // The stats snapshot lists them all, and only a request the checkpoint
  // passed adds one: what a refused request says is not recorded as fact.
  for (const field of report.unknownTopLevelFields) {
    if (stats.firstSightOfUnknownHookField(field)) {
      dlog(
        "info",
        `schema: unknown field ${JSON.stringify(field)} — Anthropic may have added it`,
      );
    }
  }
  const hints = parseClientHints(req);
  // [LAW:dataflow-not-control-flow] The *request's* cwd, not the daemon's
  // process.cwd(), so config resolution depends only on request data — the
  // daemon's own working directory must not influence output.
  const { configFile, refusedArgs } = parseRenderArgs(req.args, req.cwd);
  return {
    ok: true,
    req: {
      ...req,
      deadline,
      sessionId: sessionId.id,
      hints,
      rateLimits: rateLimitsSeen(req.hookData),
      requested: {
        projectDir: req.hookData.workspace.project_dir,
        cwd: req.cwd,
        configFile: configFile ?? hints.configEnv ?? null,
      },
      refusedArgs,
    } as CheckedRenderRequest,
  };
}

// The answer to a request the checkpoint refused.
const refusedRender = (problems: string[]) => ({
  outcome: { kind: "bad-request", problems } as const,
  resp: {
    ok: false,
    error: `malformed hookData: ${problems.join("; ")}`,
    code: "BAD_REQUEST",
    daemonV: PROTOCOL_VERSION,
  } satisfies Response,
  delivered: NOTHING_DELIVERED,
});

// What a render of a checked request draws with, resolved once and held for
// the render: the state and the session's view of it, the globals it resolves
// under the session's picks, and what its payload reads. Disposing it releases
// the hold. `facts` is the render event's record, filled as each stage learns
// its part.
interface RenderSetup extends Disposable {
  readonly req: CheckedRenderRequest;
  readonly at: Instant;
  readonly facts: RequestFacts;
  readonly sessionId: SessionId;
  readonly entry: CacheEntry;
  readonly state: DslRenderState;
  readonly view: SessionView<SessionSource>;
  readonly hintsError: string | null;
  // What the request's refresh and wait read (settlePayload).
  readonly payloadInputs: PayloadInputs;
}

// What a render notes of the request it draws by, and the error message for
// the hints that request refused.
function requestFacts(
  req: CheckedRenderRequest,
  at: Instant,
  facts: RequestFacts,
): string | null {
  noteFacts(facts, {
    sid: req.sessionId,
    at: at.toFixed(3),
  });
  // [LAW:parse-dont-validate] The ONE checkpoint for everything the client
  // observed and the daemon cannot. Raw `req.*` hint fields are not read
  // past this line; `hints` is the stamped type the render path consumes.
  //
  // [LAW:single-enforcer] Every hint is captured client-side because the
  // daemon is detached and shared: its env answers for whichever shell
  // spawned it. We do NOT consult getTerminalWidth's env/stderr fallbacks
  // for width, and we do NOT consult SSH_* for remoteness — both would
  // describe a different session than the one being rendered.
  const hints = req.hints;
  const refused = refusedHints(req, hints);
  const hintsError = refusedHintsError(refused);
  noteFacts(facts, {
    termCols: String(hints.termCols ?? "?"),
    termRows: String(hints.termRows ?? "?"),
    refused: refused.map((r) => r.hint).join(",") || "-",
    badArgs: req.refusedArgs.map((r) => `${r.arg}:${r.why}`).join(",") || "-",
    // Which program drew this bar (src/client-hint.ts); `unreported` for a
    // client too old to say.
    client: hints.client?.kind ?? "unreported",
    // What the sighting recorded of the rate-limit windows — the fact the
    // doctor's segment-data check reads (RenderSightings).
    rateLimits: req.rateLimits,
  });
  return hintsError;
}

function setUpRender(
  req: CheckedRenderRequest,
  at: Instant,
  facts: RequestFacts,
): RenderSetup {
  const sessionId = req.sessionId;
  const hintsError = requestFacts(req, at, facts);
  // [LAW:one-source-of-truth] The explicit config path has three
  // spellings and ONE precedence: a load-config pick (sessionRenderOrigin)
  // over the `--config` flag over the client's `CC_CANDYBAR_CONFIG` hint
  // (checkRenderRequest). All three are client facts; the daemon's own env is
  // never consulted (brandon-config-5g8).
  const origin = sessionRenderOrigin(req.requested, sessionState, sessionId);
  // [LAW:no-ambient-temporal-coupling] Held, not fetched: `state`, and the
  // session's `view` of it, are what this render resolves its payload from and
  // draws with after the payload await below. An eviction, a reload, or the
  // session's own render from another entry meanwhile retires them, and the
  // cache disposes them when this hold is released — never under the render
  // (brandon-unfiled-3248.6rc). The setup owns the hold from here: a throw
  // before it is returned releases it, and the setup releases it on every exit
  // of the render that disposes it.
  const hold = renderCache.holdSession(
    origin.projectDir,
    origin.cwd,
    origin.configFile ?? undefined,
    req,
  );
  return setUpDraw(hold, req, hintsError, at, facts);
}

// [LAW:effects-at-boundaries] A frame's setup: the session's view as it finds
// it, drawn by the request the view is declared with, or null while the
// session has no view. It opens nothing (`holdView`).
function setUpFrame(
  sessionId: string,
  at: Instant,
  facts: RequestFacts,
): RenderSetup | null {
  const hold = renderCache.holdView(sessionId);
  if (hold === null) {
    // [LAW:no-silent-failure] A view that failed to open draws its error, as
    // the render that threw it did, never the last bar the feed pushed.
    const failed = renderCache.openFailure(sessionId);
    if (failed !== null) throw failed.error;
    return null;
  }
  const req = hold.view.facts();
  let hintsError: string | null;
  try {
    hintsError = requestFacts(req, at, facts);
  } catch (e) {
    hold[Symbol.dispose]();
    throw e;
  }
  return setUpDraw(hold, req, hintsError, at, facts);
}

// The setup over a held view, which owns the hold from here: a throw before
// it is returned releases it.
function setUpDraw(
  hold: SessionHold<SessionSource, CheckedRenderRequest>,
  req: CheckedRenderRequest,
  hintsError: string | null,
  at: Instant,
  facts: RequestFacts,
): RenderSetup {
  try {
    const { entry, state, view } = hold;
    const { sessionId, hints } = req;
    // [LAW:dataflow-not-control-flow] One composition every render: the
    // entry always holds a renderable state (the bundled default until a
    // config loads — src/daemon/cache/render.ts), so body = drawDsl(state)
    // and output = diagnostics + body, with no "did the config load" branch.
    // The picks as the request arrived: what its refresh reads. The draw
    // settles its own (drawRender).
    const effective: EffectiveGlobals = view.source.effective();
    const payloadInputs: PayloadInputs = {
      hookData: req.hookData,
      deps: {
        ...payloadProviders,
        // The lanes the session's view declared: what this render reads of
        // the daemon's shared entries.
        lanes: view.lanes,
      },
      cwd: req.cwd,
      neededInputPaths: state.neededInputPaths(effective.preset),
      hints,
    };
    return {
      req,
      at,
      facts,
      sessionId,
      entry,
      state,
      view,
      hintsError,
      payloadInputs,
      [Symbol.dispose]: () => hold[Symbol.dispose](),
    };
  } catch (e) {
    hold[Symbol.dispose]();
    throw e;
  }
}

// [LAW:one-source-of-truth] The one draw of a render, a request's or a
// frame's: synchronous, so between its payload's values and its bytes nothing
// is awaited and nothing refreshed. Returns the bar at the setup's instant and
// its motion (`DrawnMotion`, read off the frame this render drew). A throw is
// the caller's to record.
function drawRender(
  setup: RenderSetup,
  drawing: Drawing,
): {
  drawn: DrawnBar;
  motion: DrawnMotion;
  evaluated: number;
  clickShown: ClickErrorRecord | null;
  // Which animation lanes the session's settings switch on, as drawn.
  lanes: LaneSwitches;
} {
  const { req, at, facts, sessionId, entry, state, view, hintsError } = setup;
  // [LAW:no-ambient-temporal-coupling] The picks this draw settles in its own
  // turn, the one its slots and payload are read in: a pick that moved during
  // a request's wait is drawn as one snapshot of the new one.
  // [LAW:one-source-of-truth] Every globals field as the session's view
  // resolved it (src/daemon/session-source.ts) — the same struct its
  // payload's `*.effective` fields (what a trigger label says) are read
  // from, and renderOpts below (what actually renders). One resolution, two
  // readers, so a label can never disagree with the bar. The precedence
  // the resolver applies, and why each rung sits where it does, lives
  // with the chain (resolveEffectiveGlobals, and src/config/presets.ts).
  const effective = view.source.effective();
  // Which animation lanes this session's settings switch on, as drawn.
  const lanes = laneSwitches(effective);
  noteFacts(facts, {
    lanes: LANE_NAMES.filter((lane) => lanes[lane]).join(",") || "-",
  });
  // [LAW:one-source-of-truth] The width is `renderWidth` of the hints the
  // view draws by — the client's cols, else the default, less Claude Code's
  // reserve — the same request its payload carries as `term.cols`.
  const { hints } = view.facts();
  const width = renderWidth(hints);
  noteFacts(facts, { width: String(width) });
  // [LAW:one-source-of-truth] What the view keeps, and the facts of this
  // draw's own instant (DRAW_PROJECTIONS): who it is for, the frames each
  // lane was sent in the second up to it, and the day `today` sums.
  const payload = view.source.payload();
  // [LAW:no-ambient-temporal-coupling] The click error dispatch held for this
  // session, at this draw's instant and for whom it draws: shown by every
  // render inside its hold, and past it by a request until an answer has
  // carried it.
  const clickHold = clickErrorAt(sessionState, sessionId, at, drawing.by);
  const clickShown =
    clickHold.kind === "held" || clickHold.kind === "owed"
      ? clickHold.error
      : null;
  // [LAW:one-source-of-truth] The daemon-wide update notice, read for
  // THIS session: what it dismissed and whether its config allows the
  // notice — both values, folded by the notice into zero or one message.
  const updates = updateWatch.notice({
    sessionId,
    dismissed: sessionState.get(sessionId, UPDATE_DISMISSED_KEY),
    enabled: effective.updateNotice,
  });
  // [LAW:single-enforcer] Each repository awaiting the user's answer asks,
  // in every session drawn from the entry, until one of them answers.
  const questions = repoQuestions(entry.repos, sessionId, linkSigner);
  // What a load or a request could not honour: each its own message, named by
  // what it is about. A load's error is about the session's config, and a
  // drop about the file that wrote it, so their text may change under an open
  // viewer (an issue fixed) without becoming another message; a request's
  // refusal, its hints' and a click's are about exactly what their text says.
  const said = (text: string | null | undefined) => ({ about: text, text });
  const errors = [
    said(refusedArgsError(req.refusedArgs)),
    said(hintsError),
    { about: "load", text: entry.lastError },
    ...state.dropped.map((e) => ({
      about: `dropped\0${e.file}`,
      text: e.message,
    })),
    said(clickShown?.text),
  ].flatMap(({ about, text }) => (about && text ? [{ about, text }] : []));
  const loadWarnings: readonly LoadWarning[] =
    entry.lastWarning === null
      ? []
      : [{ kind: "load", message: entry.lastWarning }];
  // [LAW:one-source-of-truth] ONE list per draw, built before it: the door's
  // indicator reads it as the `diagnostics` projection and the viewer pages
  // the same object, so the two cannot disagree within a frame. The render
  // warnings are this renderer's recorded ones — known only after a walk, so
  // the frame before this one's — with every other renderer's for the
  // session (src/daemon/render-warnings.ts).
  const scope = { config: state.config };
  const diagnostics = collectDiagnostics(
    errors,
    [...updates, ...questions],
    [
      ...loadWarnings,
      ...renderWarnings.ofSession(sessionId, drawing.by, scope),
    ].map((w) => ({ about: `${w.kind}\0${w.message}`, text: w.message })),
  );
  const projected = {
    diagnostics: diagnosticsProjection(diagnostics),
    drawing,
    feeds: frameFeeds.feedsOf(sessionId, at),
    today: todayOf(
      payloadProviders,
      view.lanes().today,
      view.facts().hookData,
      at,
    ),
  };
  const metrics = isPending(payload.metrics) ? undefined : payload.metrics;
  noteFacts(facts, sourcesFactOf(view.lanes().sources));
  noteFacts(facts, {
    prompts: String(metrics?.messageCount ?? "-"),
    nonPrompts: String(metrics?.nonPrompts ?? "-"),
    pr: prFactOf(
      payload.git,
      gitOptionsFromClosure(setup.payloadInputs.neededInputPaths)
        .showPullRequest === true,
    ),
    feeds: feedsFact(projected.feeds),
  });
  // [LAW:no-silent-failure] What renderDsl had to settle for itself and could
  // not honour (`RenderWarning`): this frame's own, recorded for its renderer
  // after the walk, so the bar still renders and the indicator counts them.
  const drawnWarnings: RenderWarning[] = [];
  // [LAW:one-source-of-truth] The options renderDsl draws with are the SAME
  // `effective` struct the payload was just built from, projected by the one
  // `renderOptionsOf` every renderer shares — no second `?? DEFAULT_X`
  // computation to drift from it.
  const renderOpts = renderOptionsOf(effective, width);
  const effects = effectSessions.of(sessionId);
  const idleSince = menuIdle.since(sessionId, at);
  // [LAW:single-enforcer] The view's inputs read its source (`bindView`, at
  // its opening): the draw hands only its own instant's facts.
  const frame = drawDsl(
    state.config,
    state.compiled,
    view.store,
    view.registry,
    projected,
    at,
    renderOpts,
    // [LAW:single-enforcer] The per-segment StripCell sink for the
    // `debug segments` projection. Its identity stays stable for the
    // view's lifetime; drawDsl clears + repopulates it
    // in place. Cells are cheap (already computed during the render);
    // the per-segment ANSI serialization happens lazily inside the
    // debug handler so normal renders pay no extra serializer cost.
    {
      perSegmentSink: view.lastRenderCellsBySegment,
      onRenderWarning: (warning) => drawnWarnings.push(warning),
    },
    // [LAW:one-source-of-truth] The draw's own settings and the session's
    // effect memory. The theme, style and effect are not among them: the
    // view's slots settle those names (src/dsl/parts.ts), the same ones its
    // payload's `.effective` fields read.
    { ...effective, effects, idleSince },
  );
  // What this frame drew is what the session's close timer follows.
  menuIdle.observe(sessionId, at, frame.menuRows > 0, effective.menuTimeout);
  const menusSince = menuIdle.since(sessionId, at);
  noteFacts(facts, {
    menuIdle:
      menusSince === undefined
        ? "-"
        : `${(at - menusSince).toFixed(1)}s/${effective.menuTimeout}s`,
  });
  // [LAW:no-silent-failure] Every frame records what it warned; a record that
  // moved is shown by the renderer's next frame: a feed's next spaced frame,
  // a request's next poll. Nothing wakes for it, since a frame whose own
  // indicator moves what it warns would wake itself forever.
  const recorded = renderWarnings.drawn(
    sessionId,
    drawing.by,
    scope,
    drawnWarnings,
  );
  const geometry: DiagnosticGeometry = {
    width,
    // A feed's one frame is shown by every lane switched on, so it pages
    // within the shortest of their surfaces.
    rows: viewerRowCap(
      hints.termRows,
      drawing.by === "feed"
        ? LANE_NAMES.flatMap((lane) => {
            const rows = LANES[lane].rows;
            return lanes[lane] && rows !== null ? [rows] : [];
          })
        : [],
    ),
    colorCompatibility: effective.colorCompatibility,
  };
  // [LAW:dataflow-not-control-flow] The viewer, while open, takes the body's
  // place: open only while the message it was opened on is in this list.
  const viewing = viewedIndex(
    sessionState.get(sessionId, DIAGNOSTICS_VIEWING),
    diagnostics,
  );
  const g = gitService.getStats();
  const u = usageStore.getStats();
  const fx = effects.lastFrame();
  // Each placement wearing its own effect, on its own clock; `-` for none.
  const own =
    fx.own
      .map((o) => `${o.placement}:${o.effect}@${o.t.toFixed(3)}`)
      .join(",") || "-";
  // Each placement fading in, and each dissolving out, on its own clock;
  // `-` for none.
  const passages = (frames: readonly PassageFrame[]): string =>
    frames.map((f) => `${f.placement}@${f.t.toFixed(3)}`).join(",") || "-";
  // [LAW:nothing-unseen] Each warning this frame met, the load's and its own
  // walk's, in order; `-` for none. A rule's tag names
  // the slot that fell to its floor (`rule:style`), and a refresh's the
  // variable that stopped (`refresh:stamp`), so the event says which.
  // [LAW:types-are-the-program] Exhaustive over the kinds: a new kind is a
  // compile error here until the event says how to name it.
  const tagOf = (w: LoadWarning | RenderWarning): string => {
    switch (w.kind) {
      case "rule":
        return `rule:${w.slot}`;
      case "refresh":
        return `refresh:${w.variable}`;
      case "load":
      case "band-floor":
      case "when":
        return w.kind;
    }
  };
  const warned =
    [...loadWarnings, ...drawnWarnings].map(tagOf).join(",") || "-";
  noteFacts(facts, {
    git: `${g.size}/${g.hits}h/${g.misses}m`,
    usage: `${u.size}/${u.hits}h/${u.misses}m`,
    effect: fx.effect,
    effectT: fx.t.toFixed(3),
    // The rate the session's animation clock ran at for this frame.
    speed: `${fx.speed}x`,
    effectRows: `${fx.made}made/${fx.reused}reused`,
    effectOwn: own,
    fadeBasis: fx.basis,
    stateRev: String(fx.revision),
    fades: passages(fx.fades),
    leaves: passages(fx.leaves),
    // What the frame drew: whether anything on it changes without new data.
    motion: frame.motion,
    // How many of the view's parts it evaluated: between data changes, only
    // those that read the instant (src/dsl/parts.ts).
    evaluated: String(frame.evaluated),
    // The sources it drew as not answered yet; `-` for none.
    pending: frame.pending.join(",") || "-",
    // Each globals rule in force, as its slot settled it: `kept` outside the
    // draw, `per-draw` at this frame's instant; `-` for none.
    rules:
      [...frame.rules].map(([slot, how]) => `${slot}:${how}`).join(",") || "-",
    err: errors.length > 0 ? "Y" : "N",
    clickError: clickHold.kind === "none" ? "-" : clickHold.kind,
    upd: String(updates.length),
    // How many repositories the bar asked about.
    ask: String(questions.length),
    warn: warned,
    // What the indicator counted, and whether this frame's warnings moved
    // its renderer's record (`new`) or matched it (`kept`).
    diag: String(diagnostics.length),
    warnRecord: recorded ? "new" : "kept",
    // The message the viewer showed in the body's place, `-` while closed.
    viewer:
      viewing === null
        ? "-"
        : `${viewing.index}/${diagnostics.length}p${viewing.page + 1}`,
  });
  return {
    drawn: {
      body:
        viewing === null
          ? frame.text
          : viewerRows(diagnostics, viewing, sessionId, geometry),
      viewerOpen: viewing !== null,
      diagnostics,
      geometry,
    },
    motion: frame.motion,
    evaluated: frame.evaluated,
    clickShown,
    lanes,
  };
}

// The warning a load carried, beside what a draw could not honour.
interface LoadWarning {
  readonly kind: "load";
  readonly message: string;
}

// What one render drew: the body — the bar, or the viewer in its place — and
// what the statusline's handoff line is drawn from: whether the body is the
// viewer, the draw's one diagnostic list, and the geometry.
interface DrawnBar {
  readonly body: string;
  readonly viewerOpen: boolean;
  readonly diagnostics: DiagnosticList;
  readonly geometry: DiagnosticGeometry;
}

// The response's bar.
function composeBar(drawn: DrawnBar): string {
  return drawn.body + "\n";
}

// [LAW:effects-at-boundaries] What a render request said, recorded where the
// request arrives — never by a frame, which only draws, and which would wake
// its own feed by writing the session's state. Compared before writing:
// every set() persists and fires the session's MobX atom, so an
// unconditional per-request write would invalidate every state-driven
// computed each render.
function recordRequest(req: CheckedRenderRequest): void {
  const sessionId = req.sessionId;
  // [LAW:one-source-of-truth] The STAMPED hints: a click arrives with no
  // hints of its own, so the doctor (verbs/index.ts) reads the facts of this
  // session's last request from here, re-parsed through the same checkpoint.
  // The client itself is not recorded: which client drew a session's bar is
  // RenderSightings' fact (src/daemon/render-sightings.ts), held in memory,
  // and two clients drawing one session would otherwise rewrite this
  // persisted record on every request.
  const { client: _client, ...recorded } = req.hints;
  const hintRecord = JSON.stringify(recorded);
  if (sessionState.get(sessionId, SESSION_CLIENT_HINTS_KEY) !== hintRecord) {
    sessionState.set(sessionId, SESSION_CLIENT_HINTS_KEY, hintRecord);
  }
  // [LAW:one-source-of-truth] The config inputs this request named, so a
  // durable click on this session resolves the same chain (under the
  // session's load-config pick, verbs/index.ts sessionOrigin) and writes the
  // file the next reload reads — never a path re-derived from the daemon's
  // own cwd.
  const origin = encodeRenderOrigin(req.requested);
  if (sessionState.get(sessionId, SESSION_RENDER_ORIGIN_KEY) !== origin) {
    sessionState.set(sessionId, SESSION_RENDER_ORIGIN_KEY, origin);
  }
}

// A render request's answer: what it said is recorded, and the bar is drawn.
interface RequestAnswer {
  // What this request's client is answered with: the statusline's answer to
  // Claude Code's statusline, the bar to a client drawing it itself.
  answer: string;
  motion: DrawnMotion;
  clickShown: ClickErrorRecord | null;
}

async function answerRequest(
  req: CheckedRenderRequest,
  at: Instant,
  wait: RequestWait,
  facts: RequestFacts,
): Promise<RequestAnswer> {
  recordRequest(req);
  return drawAnswer(req, at, wait, facts);
}

// [LAW:effects-at-boundaries] What a request's arrival starts beyond its
// own answer, in its arrival turn, by the lanes its session's settings switch
// on as it arrived: the setups its session's clicks owe
// (src/daemon/lane-setup.ts), and the tmux status line its switch and pane
// hold (src/daemon/tmux-status.ts) — held again here after `answered`
// released it, and by nothing between requests, so a status line another
// session's save turned off is never re-taken from a remembered switch. No
// draw starts either.
function arrived(req: CheckedRenderRequest, lanes: LaneSwitches): void {
  laneSetups.noted(laneSessionOf(req), lanes);
  tmuxStatusLines.observe(
    req.hookData.session_id,
    req.hints.tmux,
    lanes.tmuxStatus,
  );
}

// [LAW:one-source-of-truth] A session as a lane's setup needs it: what its
// request `req` reported, and the config inputs it renders from now.
function laneSessionOf(req: CheckedRenderRequest): LaneSession {
  const sessionId = req.hookData.session_id;
  return {
    sessionId,
    hints: req.hints,
    origin: sessionRenderOrigin(req.requested, sessionState, sessionId),
    transcript: req.hookData.transcript_path,
    answered: answeredOf(req.hookData),
  };
}

// What follows a click of `sessionId` that found its lane switches at
// `before` and left them at `after`: each lane it moved is set up for the
// session as its latest request reported it, or owed to its first request;
// and a tmux status line switch it moved is followed in the pane that request
// reported. A click that left that switch alone holds nothing: the pane is
// only remembered, and `answered` may have released it to the session that
// took it since.
function laneClicked(
  sessionId: string,
  before: LaneSwitches,
  after: LaneSwitches,
): void {
  const latest = frameFeeds.latest(sessionId);
  laneSetups.clicked(
    sessionId,
    latest === null ? null : laneSessionOf(latest),
    before,
    after,
  );
  if (latest !== null && before.tmuxStatus !== after.tmuxStatus)
    tmuxStatusLines.observe(sessionId, latest.hints.tmux, after.tmuxStatus);
}

// A request's wait, fixed at its arrival: whether its client stated its
// deadline, the milliseconds the wait had then, and when it ends, on the
// monotonic clock. Both, because the render notes the first on its event
// after the session's id leads it, and has no arrival instant to derive it.
interface RequestWait {
  readonly stated: ClientDeadline["kind"];
  readonly ms: number;
  readonly endsAt: number;
}

async function drawAnswer(
  req: CheckedRenderRequest,
  at: Instant,
  wait: RequestWait,
  facts: RequestFacts,
): Promise<RequestAnswer> {
  using setup = setUpRender(req, at, facts);
  arrived(req, laneSwitches(setup.view.source.effective()));
  noteFacts(facts, { deadline: `${wait.stated}:${wait.ms}ms` });
  // Rules 1 and 2 of the model: the answer shows what this request carried,
  // so it waits for the refreshes its arrival triggers, the first value of
  // every keyed lane its view declared, and every run of its view's or its
  // directory's sources that answers a new key — a first value, or a key its
  // fields moved — until its client's deadline. What has not
  // answered by then draws as pending, and lands for the next frame.
  const waitFrom = performance.now();
  const refreshed: Refreshed = new Map();
  const ended = await waitWithin(
    (signal) =>
      Promise.all([
        settlePayload(setup.payloadInputs, at, refreshed),
        setup.view.registry.inFlight(signal),
      ]),
    wait.endsAt - waitFrom,
    // [LAW:no-silent-failure] The answer is drawn; a wait that fails after
    // it is a bug, said against the session, never one that ends the daemon.
    (e) =>
      dlog(
        "error",
        `render wait failed after its deadline sid=${JSON.stringify(setup.sessionId)}: ${inspect(e)}`,
      ),
  );
  // [LAW:nothing-unseen] How the wait went, on the render event: an answer
  // drawn with values pending says so by name.
  const drawFrom = performance.now();
  noteFacts(facts, {
    waited: `${Math.round(drawFrom - waitFrom)}ms`,
    ended,
    refreshed: refreshedFact(refreshed),
  });
  const { drawn, motion, clickShown, lanes } = drawRender(setup, ANSWERING);
  const output = composeBar(drawn);
  const sessionId = req.sessionId;
  const elsewhere = handedOffTo(lanes, frameFeeds.following(sessionId));
  const statusline = statuslineOf(sessionId, drawn, output, elsewhere);
  // A `frames` display draws the bar itself; Claude Code's statusline hands
  // it to the lanes drawing it elsewhere.
  const toStatusline = roleOf(req.hints.client ?? null) === "statusline";
  // [LAW:nothing-unseen] Which lanes the statusline handed the bar to, and
  // how long the turn after the wait took to make the answer — what the
  // draw's reserve is held to (DRAW_RESERVE_MS).
  noteFacts(facts, {
    handoff: (toStatusline ? elsewhere : []).join(",") || "-",
    drew: `${Math.round(performance.now() - drawFrom)}ms`,
  });
  return {
    answer: toStatusline ? statusline : output,
    motion,
    clickShown,
  };
}

// What Claude Code's statusline shows of `drawn`: the bar (`output`), or —
// while lanes draw it `elsewhere` — the handoff line, which says where, with
// the bar's indicator after it. [LAW:one-source-of-truth] The indicator reads
// the draw's one list, and its click opens the one viewer: while it is open
// the statusline shows it, the same body the lanes draw.
function statuslineOf(
  sessionId: string,
  drawn: DrawnBar,
  output: string,
  elsewhere: readonly Lane[],
): string {
  const [first, ...rest] = elsewhere;
  return first === undefined || drawn.viewerOpen
    ? output
    : handoffRows(
        laneHandoff(sessionId, [first, ...rest]),
        drawn.diagnostics,
        sessionId,
        drawn.geometry,
      ) + "\n";
}
