import fs from "node:fs";
import net from "node:net";
import v8 from "node:v8";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspect, parseArgs } from "node:util";
import {
  daemonDir,
  diagnosticsDir,
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
import { dirname, isAbsolute } from "node:path";
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
  ClientHints,
  RefusedArg,
  RenderRequest,
  Request,
  Response,
  SubscribeRequest,
} from "./protocol";
import { createPayloadProviders } from "./payload-providers";
import {
  RenderCache,
  renderCacheBudget,
  type DslRenderState,
} from "./cache/render";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
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
  BadVerbArgs,
  SESSION_RENDER_ORIGIN_KEY,
  SESSION_CLIENT_HINTS_KEY,
  encodeRenderOrigin,
  sessionRenderOrigin,
  type RenderOrigin,
} from "./verbs";
import { settingCounts } from "./setting-drafts";
import { validateHookData } from "../utils/schema-validator.js";
import { transcriptReads } from "../utils/transcript-fs.js";
import { fileStores, productionEdge, readStores } from "../doctor/edge";
import { ProbeArrivals } from "../doctor/handler-probe";
import {
  RenderSightings,
  rateLimitsSeen,
  roleOf,
  transcriptSaid,
  type FrameSeen,
  type RateLimitsSeen,
} from "./render-sightings";
import { claudeConfigDir } from "../claude-settings";
import { setLaunchStats } from "../proc/launch";
import { buildDebugSnapshot } from "./debug";
import { DEBUG_WHATS, isDebugWhat } from "./debug-types";
import { drawDsl, type RenderWarning } from "../dsl/render.js";
import type { DrawnMotion } from "../render/drawn-motion.js";
import {
  renderStripCells,
  DEFAULT_COLOR_COMPATIBILITY,
  DEFAULT_PADDING,
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_WRAP,
  type BuildLineOptions,
  type ColorCompatibility,
} from "../render/strip.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";
import type { RichText } from "@promptctl/rich-js";
import {
  buildRenderPayload,
  renderOptionsOf,
  prFactOf,
  type RenderPayloadDeps,
} from "./render-payload.js";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "../config/effective-globals.js";
import { EffectSessions, type PassageFrame } from "../render/effect.js";
import { FEED_PERIODS, FrameFeeds, type FeedFrame } from "./frame-feed.js";
import {
  LANE_NAMES,
  parseLane,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import {
  answeredClickError,
  clickErrorAt,
  type ClickErrorRecord,
  type ClickErrorRender,
} from "./click-error.js";
import { newestWins } from "../utils/newest-wins.js";
import {
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  PaneVisibility,
} from "./pane-visibility.js";
import { runTmuxAsync } from "../proc/tmux.js";
import { reaction } from "mobx";
import { setImmediate } from "node:timers";
import type { RenderedLine } from "../dsl/node-registry.js";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { LaneSetups } from "./lane-setup.js";
import { productionLaneEdge } from "./lane-edge.js";
import { handedOffTo, laneHandoff } from "./lane-handoff.js";
import {
  collectDiagnostics,
  diagnosticRows,
  composeWithDiagnostics,
  diagnosticRowCap,
  formatDiagnosticDump,
  type DiagnosticGeometry,
  type Diagnostics,
  type FullTextLink,
} from "../render/diagnostic-strip.js";
import { DiagnosticDump } from "./diagnostic-dump.js";
import { instantOf, type Instant } from "../utils/instant.js";
import {
  noteFacts,
  renderEvent,
  type RenderFacts,
  type RenderOutcome,
} from "./render-event.js";

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
// [LAW:single-enforcer] `mementoProvider` is the one owner of memento's
// ceiling: the payload reads through it and the ceiling verb moves through it,
// so a click drops the very reading it made stale.
const payloadProviders = createPayloadProviders({
  watchers: watcherRegistry,
  logger: dlog,
});
const {
  gitProvider: gitService,
  usageStore,
  mementoProvider,
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
// [LAW:single-enforcer] The one owner of what turning an animation lane on or
// off takes (src/daemon/lane-setup.ts), told the switches every render draws by.
const laneSetups = new LaneSetups({
  edge: productionLaneEdge(dirname(socketPath()), (sessionId) =>
    frameFeeds.following(sessionId),
  ),
  // A bar pane runs this bundle under the node running it now, with the
  // flags it runs with (tsx's loader, under the test harness).
  host: {
    bundle: DAEMON_BUNDLE,
    node: [process.execPath, ...process.execArgv],
    socket: socketPath(),
  },
  state: sessionState,
  log: dlog,
  now: () => instantOf(new Date()),
  defer: (run) => void setImmediate(run),
});
// Each subscribed session's frames, drawn from its latest render request
// (candybar-animation-wbxz.jmm.usl). A change to the session's own state — a
// click — draws its next frame at once.
const frameFeeds: FrameFeeds<CheckedRenderRequest> = new FrameFeeds({
  render: (req) => renderFrame(req),
  // [LAW:no-ambient-temporal-coupling] The wake runs on the next turn of the
  // event loop, not inside the session write that changed the revision, so a
  // click's whole run of writes lands before a frame of it is drawn.
  watch: (sessionId, onChange) =>
    reaction(() => sessionState.revision(sessionId), onChange, {
      scheduler: (run) => setImmediate(run),
    }),
  lanes: (req) => lanesOf(req),
  shown: (req) => paneVisibility.shown(req.hints.tmux),
  watching: () => paneVisibility.follow(),
  periods: FEED_PERIODS,
  now: () => Date.now(),
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
  // Only the sessions on a server whose view changed are drawn again.
  onChange: (sockets) =>
    frameFeeds.wakeWhere((req) =>
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
// [LAW:locality-or-seam] Same terms as sessionState: naming the directory is
// free; the daemon wipes it in onListening() (reset), once the bind is
// won, and is the only writer.
const diagnosticDump = new DiagnosticDump(diagnosticsDir());
const renderCache = new RenderCache(
  {
    gitService,
    sessionState,
    watchers: watcherRegistry,
    log: dlog,
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
      // daemon.log beside the "config change detected" line that preceded it
      // — the operator's only record of whether a save was picked up cleanly,
      // kept rendering last-known-good behind an error, or resolved to a
      // different file. Same info level as the detection line.
      onReload: (entry) =>
        dlog(
          "info",
          `config loaded projectDir=${entry.projectDir} cwd=${entry.cwd} files=${entry.configLayers.join(" < ") || "<bundled default>"} error=${entry.lastError === null ? "none" : JSON.stringify(entry.lastError)} warning=${entry.lastWarning === null ? "none" : JSON.stringify(entry.lastWarning)}`,
        ),
    },
  },
);

const REQUEST_TIMEOUT_MS = 200;
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
  // The dump directory is a cold-rebuilt cache like every other: whatever a
  // previous daemon wrote there is unnamed by any strip this one renders.
  // After the bind win, like every other "we are the daemon" effect: a
  // process that loses the race must never touch the winner's files.
  const wipeFailure = diagnosticDump.reset();
  if (wipeFailure !== null)
    dlog("warn", `diagnostic dump wipe failed: ${wipeFailure}`);
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
  try {
    gitService.close();
  } catch (e) {
    dlog("warn", `gitService close failed: ${(e as Error).message}`);
  }
  try {
    usageStore.close();
  } catch (e) {
    dlog("warn", `usageStore close failed: ${(e as Error).message}`);
  }
  try {
    watcherRegistry.closeAll();
  } catch (e) {
    dlog("warn", `watcherRegistry close failed: ${(e as Error).message}`);
  }
  try {
    sessionState.flush();
  } catch (e) {
    dlog("warn", `sessionState flush failed: ${(e as Error).message}`);
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
  // Every dlog above was a synchronous append (log.ts), so the death line is
  // already on disk; nothing to flush before exit.
  process.exit(code);
}

// --- per-connection handler ---

function handleConnection(sock: net.Socket): void {
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
        error: "request exceeded 200ms",
        code: "TIMEOUT",
        daemonV: PROTOCOL_VERSION,
      },
      null,
      NOTHING_DELIVERED,
    );
  }, REQUEST_TIMEOUT_MS);

  const reader = makeFrameReader(
    (frame) => {
      void handleRequest(frame as Request, () => timedOut)
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
  | { kind: "subscribe"; sessionId: string; lane: Lane };

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
  if (typeof req.sessionId !== "string" || req.sessionId === "")
    return refuse(
      "BAD_REQUEST",
      "subscribe needs a non-empty string sessionId",
    );
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
  return { kind: "subscribe", sessionId: req.sessionId, lane };
}

export async function handleRequest(
  req: Request,
  timedOut: () => boolean,
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
  return replied(await replyTo(req, timedOut));
}

// The reply to a request of any kind but a subscribe, past the connection's
// checkpoint. The site (site/transport.ts) calls it with requests it built.
export async function replyTo(
  req: ReplyRequest,
  timedOut: () => boolean,
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
        transcriptReads: transcriptReads(),
        renderCache: renderCache.stats,
        effectCache: effectSessions.getStats(),
        sessionState: {
          sessions: sessionState.size(),
          observers: sessionState.observers(),
          revision: sessionState.latestRevision(),
        },
        frameFeeds: frameFeeds.getStats(),
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
    // [LAW:effects-at-boundaries] The one clock read of a render request: the
    // instant the bar is drawn at (every time read in the render reads it) and
    // the start its duration is measured from.
    const started = new Date();
    const at = instantOf(started);
    const t0 = started.getTime();
    // [LAW:nothing-unseen] One render event per render request, written here
    // on every exit — a refusal and a throw included — from the facts the
    // render reached, so a failing render is described like any other.
    // A throw is this request's own RENDER_FAILED reply, so the event is the
    // one record of it and the connection's catch never sees a render.
    const facts: RenderFacts = [];
    // Where this request came in the order they arrived: renders of one session
    // can finish out of it.
    // [LAW:one-source-of-truth] The count of render requests received is that
    // order.
    const order = ++stats.requestsTotal;
    const checked = checkRenderRequest(req);
    // [LAW:single-enforcer] A render REQUEST is a client sighting — the
    // frames a feed draws from a session's data are not, so this is the one
    // write, here rather than in renderChecked. It is written as the request
    // arrives, `drawing`, and again once its render settles, carrying what the
    // frame drew — both stamped with the instant and order it arrived in.
    const sighted = (req: CheckedRenderRequest, frame: FrameSeen): void =>
      renderSightings.see(
        req.hookData.session_id,
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
    if (checked.ok) sighted(checked.req, "drawing");
    const rendered: {
      outcome: RenderOutcome;
      resp: Response;
      delivered: () => void;
    } = !checked.ok
      ? refusedRender(checked.problems)
      : await answerRequest(checked.req, order, at, facts).then(
          ({ output, statusline, answer, motion, clickShown }) => {
            sighted(checked.req, motion);
            const resp = { ok: true, output } as const;
            // [LAW:one-source-of-truth] A request the render took is the
            // session's data from now on: its frames are drawn from it, and
            // this answer is its frame now.
            frameFeeds.note(
              checked.req.hookData.session_id,
              checked.req,
              order,
              {
                resp,
                statusline: { ok: true, output: statusline },
                drawnAt: t0,
                moves: motion === "moves",
                failure: null,
              },
            );
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
                        checked.req.hookData.session_id,
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
    // Whether the client was already told TIMEOUT while this render ran on.
    noteFacts(facts, { timedOut: timedOut() ? "Y" : "N" });
    const { level, line } = renderEvent(
      facts,
      rendered.outcome,
      Date.now() - t0,
    );
    dlog(level, line);
    return {
      resp: rendered.resp,
      exitAfterFlush: null,
      delivered: rendered.delivered,
    };
  }

  if (req.kind === "click") {
    return stay(
      handleClick(
        req.verb,
        req.value,
        sanitizeClientVersion(req.clientVersion),
      ),
    );
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
    // the first populated existing entry — sufficient for `debug vars`,
    // `debug segments`, `debug config` against the active workload.
    // firstState reads existing entries only; it does NOT
    // create a fresh one, so debug introspection never has the side effect
    // of standing up a new (projectDir=undefined) cache entry tied to the
    // daemon's own process.cwd(). A future debug-target selector would
    // thread (projectDir, cwd) through the wire.
    const dbgEntry = renderCache.firstState();
    // [LAW:dataflow-not-control-flow] Lazy per-segment serialization: the
    // cache stores StripCell arrays (cheap, written by renderDsl).
    // The debug projection needs strings, so serialize only for the
    // `segments` projection (`vars` and `config` don't need it) and only
    // when this request actually fires. Normal renders pay no per-segment
    // serializer cost — that work shifts to debug-request time, which is
    // operator-driven and rare.
    const dbgState =
      dbgEntry === null
        ? null
        : {
            store: dbgEntry.store,
            registry: dbgEntry.registry,
            config: dbgEntry.config,
            compiled: dbgEntry.compiled,
            lastRenderBySegment:
              req.what === "segments"
                ? serializeSegmentCells(
                    dbgEntry.lastRenderCellsBySegment,
                    dbgEntry.config.globals.colorCompatibility ??
                      DEFAULT_COLOR_COMPATIBILITY,
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
// and a positional word are refused arguments the caller shows on the strip
// and the render event.
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
    renderCache.reload(...at);
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
  memento: mementoProvider,
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
    ),
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
  endcaps: "powerline" as const,
  colorCompatibility: DEFAULT_COLOR_COMPATIBILITY,
  wrap: DEFAULT_WRAP,
  padding: DEFAULT_PADDING,
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

// [LAW:single-enforcer] The payload-builder dependency bundle. One value
// passed through every render — the data the daemon brings to each tick.
const payloadDeps: Omit<RenderPayloadDeps, "navigation"> = {
  // [LAW:single-enforcer] The providers carry `dlog` as `log`:
  // buildRenderPayload is the one log site for the outcome-carrying provider
  // lanes (git, cache).
  ...payloadProviders,
  history: (sessionId: string) => settingsHistory.depth(sessionId),
};

function handleClick(
  verb: string,
  value: string,
  clientVersion: string | null,
): Response {
  const handler = VERBS.get(verb);
  if (!handler) {
    return {
      ok: false,
      error: `unknown click verb: ${verb}`,
      code: "BAD_REQUEST",
      daemonV: PROTOCOL_VERSION,
    };
  }
  try {
    handler(value, { ...verbCtx, clientVersion });
    return { ok: true, output: "" };
  } catch (e) {
    const code = e instanceof BadVerbArgs ? "BAD_REQUEST" : "RENDER_FAILED";
    return {
      ok: false,
      error: String(e instanceof Error ? e.message : e),
      code,
      daemonV: PROTOCOL_VERSION,
    };
  }
}

// --- render ---

// One frame of a subscribed session, drawn from its latest request at this
// instant, by the render a request gets. The response is the one that request
// would be answered with, and the bar moves when its effects say it does.
// [LAW:parse-dont-validate] The request crossed the checkpoint when it was
// noted, so a frame renders it without asking again.
// [LAW:nothing-unseen] A frame that throws carries the render event a throwing
// request writes, for the feed to log when that failure is first pushed; the
// feed summarizes the frames that render.
async function renderFrame(req: CheckedRenderRequest): Promise<FeedFrame> {
  const started = new Date();
  const facts: RenderFacts = [];
  try {
    const { drawn, motion, lanes } = await renderChecked(
      req,
      instantOf(started),
      facts,
      "frame",
    );
    // [LAW:effects-at-boundaries] A frame only draws: the dump is the
    // session's requests' to write, and the frame links it only when it holds
    // this frame's text.
    const link = diagnosticDump.linkFor(
      req.hookData.session_id,
      dumpTextOf(drawn),
    );
    const sessionId = req.hookData.session_id;
    const output = composeBar(drawn, link);
    return {
      resp: { ok: true, output },
      statusline: {
        ok: true,
        output: statuslineOf(
          sessionId,
          drawn,
          link,
          output,
          handedOffTo(lanes, frameFeeds.following(sessionId)),
        ),
      },
      drawnAt: started.getTime(),
      moves: motion === "moves",
      failure: null,
    };
  } catch (error) {
    const outcome = { kind: "threw", error } as const;
    const { level, line } = renderEvent(
      facts,
      outcome,
      Date.now() - started.getTime(),
    );
    const failed = renderFailed(error);
    return {
      resp: failed,
      statusline: failed,
      drawnAt: started.getTime(),
      moves: false,
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

// The lanes the settings of the session `req` is from switch on now: its
// config, as the render cache holds it for the inputs the request named, under
// its session's picks.
function lanesOf(req: CheckedRenderRequest): LaneSwitches {
  const sessionId = req.hookData.session_id;
  const origin = sessionRenderOrigin(req.requested, sessionState, sessionId);
  using hold = renderCache.hold(
    origin.projectDir,
    origin.cwd,
    origin.configFile ?? undefined,
  );
  return sessionGlobals(sessionId, hold.state).lanes;
}

// A render request that crossed the checkpoint: its hookData carries every
// required field with its declared type, its cwd is absolute, `hints` is its
// client hints, parsed, and its args are parsed into `requested` — the config
// inputs it named, its explicit path the `--config` flag over the client's
// `CC_CANDYBAR_CONFIG` hint — and `refusedArgs`, and `rateLimits` is
// what its hookData says of the rate-limit windows. Raw `req.*` hint
// fields and `req.args` are not read past the checkpoint. Only
// checkRenderRequest makes one.
declare const CHECKED: unique symbol;
type CheckedRenderRequest = RenderRequest & {
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
  for (const field of report.unknownTopLevelFields) {
    dlog(
      "info",
      `schema: unknown field '${field}' — Anthropic may have added it`,
    );
  }
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
  if (wireProblems.length > 0) return { ok: false, problems: wireProblems };
  const hints = parseClientHints(req);
  // [LAW:dataflow-not-control-flow] The *request's* cwd, not the daemon's
  // process.cwd(), so config resolution depends only on request data — the
  // daemon's own working directory must not influence output.
  const { configFile, refusedArgs } = parseRenderArgs(req.args, req.cwd);
  return {
    ok: true,
    req: {
      ...req,
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

// The bar for a checked request, at `at`, and its motion (`DrawnMotion`, read
// off the frame this render drew). A throw is the caller's to record. `facts` is the render event's
// record, filled as each stage learns its part.
async function renderChecked(
  req: CheckedRenderRequest,
  at: Instant,
  facts: RenderFacts,
  render: ClickErrorRender,
): Promise<{
  drawn: DrawnBar;
  motion: DrawnMotion;
  clickShown: ClickErrorRecord | null;
  // Which animation lanes the session's settings switch on, as drawn.
  lanes: LaneSwitches;
}> {
  noteFacts(facts, {
    sid: req.hookData.session_id,
    at: at.toFixed(3),
  });
  const sessionId = req.hookData.session_id;
  // [LAW:parse-dont-validate] The ONE checkpoint for everything the client
  // observed and the daemon cannot. Raw `req.*` hint fields are not read
  // past this line; `hints` is the stamped type the render path consumes.
  //
  // [LAW:single-enforcer] Every hint is captured client-side because the
  // daemon is detached and shared: its env answers for whichever shell
  // spawned it. We do NOT consult getTerminalWidth's env/stderr fallbacks
  // for width, and we do NOT consult SSH_* for remoteness — both would
  // describe a different session than the one being rendered.
  // [LAW:one-source-of-truth] Both branches feed raw cols through
  // applyClaudeCodeReserve, so `width` always means "usable cells
  // post-reserve" with no semantic split between wire-supplied and
  // fallback values.
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
  // [LAW:one-source-of-truth] The explicit config path has three
  // spellings and ONE precedence: a load-config pick (sessionRenderOrigin)
  // over the `--config` flag over the client's `CC_CANDYBAR_CONFIG` hint
  // (checkRenderRequest). All three are client facts; the daemon's own env is
  // never consulted (brandon-config-5g8).
  const origin = sessionRenderOrigin(req.requested, sessionState, sessionId);
  // [LAW:no-ambient-temporal-coupling] Held, not fetched: `state` is what
  // this render resolves its payload from and draws with after the payload
  // await below. An eviction or a reload meanwhile retires it, and the cache
  // disposes it when this hold is released — never under the render
  // (brandon-unfiled-3248.6rc). `using` releases the hold on every exit.
  using hold = renderCache.hold(
    origin.projectDir,
    origin.cwd,
    origin.configFile ?? undefined,
  );
  const { entry, state } = hold;
  const termCols = hints.termCols;
  const width = applyClaudeCodeReserve(termCols ?? DEFAULT_TERMINAL_WIDTH);
  const rowCap = diagnosticRowCap(hints.termRows);
  noteFacts(facts, { width: String(width) });
  // [LAW:dataflow-not-control-flow] One composition every render: the
  // entry always holds a renderable state (the bundled default until a
  // config loads — src/daemon/cache/render.ts), so body = drawDsl(state)
  // and output = diagnostics + body, with no "did the config load" branch.
  // [LAW:one-source-of-truth] Every globals field resolved ONCE per
  // render, here — before the payload build, so the same struct feeds
  // BOTH the payload's `*.effective` fields (what a trigger label says)
  // AND renderOpts below (what actually renders). One resolution, two
  // readers, so a label can never disagree with the bar. The precedence
  // the resolver applies, and why each rung sits where it does, lives
  // with the chain (resolveEffectiveGlobals, and src/config/presets.ts).
  const sessionPick = (key: string): string | null =>
    sessionState.get(req.hookData.session_id, key);
  const effective: EffectiveGlobals = sessionGlobals(sessionId, state);
  // Which animation lanes this session's settings switch on.
  noteFacts(facts, {
    lanes: LANE_NAMES.filter((lane) => effective.lanes[lane]).join(",") || "-",
  });
  // [LAW:dataflow-not-control-flow] What a lane runs follows the switch every
  // render draws by, as the session's own setting moves moved it
  // (src/daemon/lane-setup.ts).
  laneSetups.observe(
    { sessionId, hints, origin, transcript: req.hookData.transcript_path },
    effective.lanes,
    settingsHistory.revision(sessionId),
  );
  const payload = await buildRenderPayload(
    req.hookData,
    at,
    {
      ...payloadDeps,
      // Measured against the gate of the config this render draws with.
      navigation: (sessionId: string) =>
        navigationHistory.depth(
          sessionId,
          sessionState,
          stateGate(state.config),
        ),
    },
    req.cwd,
    state.neededInputPaths(effective.preset),
    effective,
    hints,
    {
      ...settingCounts(state.config, state.fileHeldSettings, sessionPick),
      // The file the menu's saves and resets edit, once it exists.
      configPath: entry.configLayers.includes(entry.configHome)
        ? entry.configHome
        : null,
    },
  );
  noteFacts(facts, {
    prompts: String(payload.metrics?.messageCount ?? "-"),
    nonPrompts: String(payload.metrics?.nonPrompts ?? "-"),
    pr: prFactOf(payload.git),
  });
  // [LAW:no-silent-failure] What renderDsl had to settle for itself and could
  // not honour (`RenderWarning`). Collected per render into a local, so there
  // is no cross-render state to clear, and folded into the strip's WARNING
  // channel below: the bar still renders, with a line above it saying why,
  // which is this repo's answer everywhere else that a render can proceed but
  // an author needs to know.
  const renderWarnings: RenderWarning[] = [];
  // [LAW:one-source-of-truth] The options renderDsl draws with are the SAME
  // `effective` struct the payload was just built from, projected by the one
  // `renderOptionsOf` every renderer shares — no second `?? DEFAULT_X`
  // computation to drift from it.
  const renderOpts = renderOptionsOf(effective, width);
  const effects = effectSessions.of(sessionId);
  // [LAW:single-enforcer] renderDsl internally calls
  // `registry.applyInput(payload)` as its first step (see step 1 in
  // src/dsl/render.ts). The daemon must not pre-apply — doing so
  // would run the MobX action twice per render and clear last_error
  // diagnostics on the round trip.
  const frame = drawDsl(
    state.config,
    state.compiled,
    state.store,
    state.registry,
    payload,
    at,
    renderOpts,
    // [LAW:single-enforcer] The per-segment StripCell sink for the
    // `debug segments` projection. Its identity stays stable for the
    // cache entry's lifetime; renderDsl clears + repopulates it
    // in place. Cells are cheap (already computed during the render);
    // the per-segment ANSI serialization happens lazily inside the
    // debug handler so normal renders pay no extra serializer cost.
    {
      perSegmentSink: state.lastRenderCellsBySegment,
      onRenderWarning: (warning) => renderWarnings.push(warning),
    },
    // [LAW:one-source-of-truth] The theme crosses as the SELECTION, palette
    // and name together, so renderDsl publishes the `theme.effective` the
    // bar was actually painted from. No separate basePalette argument: one
    // would be a second clock free to disagree with that name.
    { ...effective, effects },
  );
  // [LAW:one-source-of-truth] The click error dispatch held for this session,
  // shown by every render inside its hold, and past it by a request until an
  // answer has carried it.
  const clickHold = clickErrorAt(sessionState, sessionId, at, render);
  const clickShown =
    clickHold.kind === "held" || clickHold.kind === "owed"
      ? clickHold.error
      : null;
  const clickError = clickShown?.text ?? null;
  const combinedError = [
    refusedArgsError(req.refusedArgs),
    hintsError,
    entry.lastError,
    clickError,
  ]
    .filter(Boolean)
    .join("\n");
  // [LAW:one-source-of-truth] The daemon-wide update notice, read for
  // THIS session: what it dismissed and whether its config allows the
  // notice — both values, folded by the notice into zero or one channel.
  const updates = updateWatch.notice({
    sessionId,
    dismissed: sessionState.get(sessionId, UPDATE_DISMISSED_KEY),
    enabled: effective.updateNotice,
  });
  // [LAW:no-silent-failure] The file whose load failed rides beside its
  // error so the strip can offer it as a file:// link — the way back into
  // the file when our own click path may be the thing that is broken.
  // Null when the error is not a load error, or no file resolved.
  const failedConfigFile = entry.lastError === null ? null : entry.failedFile;
  // [LAW:one-source-of-truth] One warning channel: the load-time warning this
  // config carries and whatever this render could not honour, in one list.
  // The strip's rows are its messages, joined into the one string
  // collectDiagnostics splits; the render event's `warn=` is its kinds. A
  // second channel would be a second place a warning could be dropped.
  const warnings = [
    ...(entry.lastWarning === null
      ? []
      : [{ kind: "load" as const, message: entry.lastWarning }]),
    ...renderWarnings,
  ];
  const diagnostics = collectDiagnostics(
    combinedError,
    updates,
    warnings.map((w) => w.message).join("\n"),
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
  // [LAW:nothing-unseen] Each warning the strip carried, in its order,
  // including any its row cap left undrawn; `-` for none. A rule's tag names
  // the slot that fell to its floor (`rule:style`), and a refresh's the
  // variable that stopped (`refresh:stamp`), so the event says which.
  // [LAW:types-are-the-program] Exhaustive over the kinds: a new kind is a
  // compile error here until the event says how to name it.
  const tagOf = (w: (typeof warnings)[number]): string => {
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
  const warned = warnings.map(tagOf).join(",") || "-";
  noteFacts(facts, {
    git: `${g.size}/${g.hits}h/${g.misses}m`,
    usage: `${u.size}/${u.hits}h/${u.misses}m`,
    effect: fx.effect,
    effectT: fx.t.toFixed(3),
    effectRows: `${fx.made}made/${fx.reused}reused`,
    effectOwn: own,
    fadeBasis: fx.basis,
    stateRev: String(fx.revision),
    fades: passages(fx.fades),
    leaves: passages(fx.leaves),
    // What the frame drew: whether anything on it changes without new data.
    motion: frame.motion,
    err: combinedError ? "Y" : "N",
    clickError: clickHold.kind === "none" ? "-" : clickHold.kind,
    upd: String(updates.length),
    warn: warned,
  });
  return {
    drawn: {
      body: frame.text,
      diagnostics,
      failedConfigFile,
      geometry: {
        width,
        rowCap,
        colorCompatibility: effective.colorCompatibility,
      },
    },
    motion: frame.motion,
    clickShown,
    lanes: effective.lanes,
  };
}

// What one render drew, before the diagnostic strip is composed over it: the
// strip's full-text link is the dump's to give, and only a request writes
// the dump.
interface DrawnBar {
  readonly body: string;
  readonly diagnostics: Diagnostics | null;
  // The file whose load failed, linked beside its error so the strip offers
  // the way back into the file when our own click path may be what is broken.
  readonly failedConfigFile: string | null;
  readonly geometry: DiagnosticGeometry;
}

// The response's bar: the strip over the body, linking the full text as
// `fullText` says.
function composeBar(drawn: DrawnBar, fullText: FullTextLink): string {
  return (
    composeWithDiagnostics(
      drawn.body,
      drawn.diagnostics,
      { fullText, failedConfigFile: drawn.failedConfigFile },
      drawn.geometry,
    ) + "\n"
  );
}

// The complete text the session's dump holds for `drawn`: present with the
// full text, absent when there are no diagnostics.
function dumpTextOf(drawn: DrawnBar): string | null {
  return drawn.diagnostics === null
    ? null
    : formatDiagnosticDump(drawn.diagnostics);
}

// [LAW:effects-at-boundaries] What a render request said, recorded where the
// request arrives — never by a frame, which only draws, and which would wake
// its own feed by writing the session's state. Compared before writing:
// every set() persists and fires the session's MobX atom, so an
// unconditional per-request write would invalidate every state-driven
// computed each render.
function recordRequest(req: CheckedRenderRequest): void {
  const sessionId = req.hookData.session_id;
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

// A render request's answer: what it said is recorded, the bar is drawn, and
// the session's dump is brought in line with it before the strip that links
// it goes out — the link is built from the write's outcome, so the trailer
// never names a file that is not there. `order` is where the request came in
// the order they arrived: the dump holds the newest request's text, however
// the renders finish.
async function answerRequest(
  req: CheckedRenderRequest,
  order: number,
  at: Instant,
  facts: RenderFacts,
): Promise<{
  // The session's bar: what its frames are, and what a client drawing the
  // bar itself is answered with.
  output: string;
  // What Claude Code's statusline shows: the bar, or the handoff line in its
  // place while a lane draws it elsewhere.
  statusline: string;
  // What this request's client is answered with: the statusline's answer to
  // Claude Code's statusline, the bar to a client drawing it itself.
  answer: string;
  motion: DrawnMotion;
  clickShown: ClickErrorRecord | null;
}> {
  recordRequest(req);
  const { drawn, motion, clickShown, lanes } = await renderChecked(
    req,
    at,
    facts,
    "request",
  );
  const { link, failure } = diagnosticDump.sync(
    req.hookData.session_id,
    order,
    dumpTextOf(drawn),
  );
  // [LAW:nothing-unseen] On the render event, not a line of its own: the
  // strip's trailer row says it on the bar either way.
  noteFacts(facts, {
    dumpFailed: failure === null ? "-" : JSON.stringify(failure),
  });
  const output = composeBar(drawn, link);
  const sessionId = req.hookData.session_id;
  const elsewhere = handedOffTo(lanes, frameFeeds.following(sessionId));
  const statusline = statuslineOf(sessionId, drawn, link, output, elsewhere);
  // A `frames` display draws the bar itself; Claude Code's statusline hands
  // it to the lanes drawing it elsewhere.
  const toStatusline = roleOf(req.hints.client ?? null) === "statusline";
  // [LAW:nothing-unseen] Which lanes the statusline handed the bar to.
  noteFacts(facts, {
    handoff: (toStatusline ? elsewhere : []).join(",") || "-",
  });
  return {
    output,
    statusline,
    answer: toStatusline ? statusline : output,
    motion,
    clickShown,
  };
}

// What Claude Code's statusline shows of `drawn`: the bar (`output`, as
// composed), or — while lanes draw it `elsewhere` — the handoff line in the
// body's place.
// [LAW:no-silent-failure] Only the body is handed off: the strip above it — a
// load error, the update notice, a click's failure — stays, and the line is
// the body, so the strip's row cap never drops it.
function statuslineOf(
  sessionId: string,
  drawn: DrawnBar,
  link: FullTextLink,
  output: string,
  elsewhere: readonly Lane[],
): string {
  const [first, ...rest] = elsewhere;
  return first === undefined
    ? output
    : composeBar(
        {
          ...drawn,
          body: diagnosticRows(
            laneHandoff(sessionId, [first, ...rest]),
            drawn.geometry,
          ),
        },
        link,
      );
}
