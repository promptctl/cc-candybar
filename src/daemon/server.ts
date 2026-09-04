import fs from "node:fs";
import net from "node:net";
import v8 from "node:v8";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  daemonDir,
  ensureSocketParentSafe,
  leasePath,
  leasePathFor,
  socketPath,
  sessionStatePath,
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
import { makeBuildWatch } from "./build-currency";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
  parseClientHints,
} from "./protocol";
import type { Request, Response } from "./protocol";
import { GitDataProvider } from "./cache/git";
import { SessionUsageStore } from "./cache/session-usage-store";
import { RenderCache } from "./cache/render";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
import {
  makeLimits,
  realLimitsDeps,
  rssLimitBytes,
  type LimitsHandle,
} from "./limits";
import { armParentWatchdog, anchorFromEnv, pidAlive } from "./parent-watchdog";
import { resetSpawnBackoff } from "./acquire";
import { SessionState } from "./session-state";
import { FileSessionStorage } from "./session-state-file";
import { VERBS, BadVerbArgs, SESSION_CONFIG_OVERRIDE_KEY } from "./verbs";
import {
  effectsUrl,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
} from "../click/wire.js";
import { validateHookData } from "../utils/schema-validator.js";
import { setLaunchStats } from "../proc/launch";
import { buildDebugSnapshot } from "./debug";
import { DEBUG_WHATS, isDebugWhat } from "./debug-types";
import { expandHome } from "../config/dsl-loader.js";
import { renderDsl } from "../dsl/render.js";
import { lookKeyByName, paletteForThemeName } from "../themes/index.js";
import { presetIsCustomized } from "../config/presets.js";
import {
  renderStripCells,
  DEFAULT_CHARSET,
  DEFAULT_COLOR_COMPATIBILITY,
  DEFAULT_PADDING,
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_WRAP,
  type BuildLineOptions,
  type Charset,
  type ColorCompatibility,
} from "../render/strip.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";
import type { RichText } from "@promptctl/rich-js";
import {
  buildRenderPayload,
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "./render-payload.js";
import { ContextProvider } from "../segments/context.js";
import { MetricsProvider } from "../segments/metrics.js";
import { TmuxService } from "../segments/tmux.js";
import { sanitizeAndTruncate } from "../render/diagnostic-text.js";
import {
  ANSI_RESET,
  DIAGNOSTIC_ERROR_BG,
  DIAGNOSTIC_ERROR_FG,
  DIAGNOSTIC_WARNING_BG,
  DIAGNOSTIC_WARNING_FG,
} from "../render/diagnostic-style.js";

// [LAW:one-source-of-truth] one cache instance per daemon process — multiple
// instances would defeat the share-across-sessions invariant.
const stats = new RuntimeStats();
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
const gitService = new GitDataProvider({
  watchers: watcherRegistry,
  logger: dlog,
});
const usageStore = new SessionUsageStore();
// [LAW:locality-or-seam] Constructed ephemeral so importing this module (CLI
// relay, subcommands) does no disk I/O. The daemon binds the file-backed
// storage in runDaemon(), making it the sole reader/writer of the state file.
const sessionState = new SessionState();
// [LAW:one-source-of-truth] One provider per data shape, shared across every
// render in this daemon. The render cache owns DSL-state-per-config; these
// providers serve the augmented payload that flows through every render.
const contextProvider = new ContextProvider();
const metricsProvider = new MetricsProvider();
const tmuxService = new TmuxService();
const renderCache = new RenderCache(
  {
    gitService,
    sessionState,
    watchers: watcherRegistry,
  },
  {
    observers: {
      // [LAW:no-silent-failure] Every config (re)load's outcome lands in
      // daemon.log beside the "config change detected" line that preceded it
      // — the operator's only record of whether a save was picked up cleanly,
      // kept rendering last-known-good behind an error, or resolved to a
      // different file. Same info level as the detection line.
      onReload: (entry) =>
        dlog(
          "info",
          `config loaded projectDir=${entry.projectDir} cwd=${entry.cwd} file=${entry.configFilePath ?? "<bundled default>"} error=${entry.lastError === null ? "none" : JSON.stringify(entry.lastError)} warning=${entry.lastWarning === null ? "none" : JSON.stringify(entry.lastWarning)}`,
        ),
    },
  },
);

const REQUEST_TIMEOUT_MS = 200;
// One cadence for "how often does the daemon look at its build on disk" —
// the binary watch (exit on a changed bundle) and the build watch (is the
// bundle older than `src/`) both sample on it.
const BIN_CHECK_INTERVAL_MS = 60 * 1000;

// [LAW:single-enforcer] The daemon is the process that observes the bundle
// it runs (armBinaryWatch restarts it on rebuild), so it is the one place
// the bundle gets compared to the source beside it. The verdict rides the
// same advisory warning channel as the config-collision detector — one
// glyph, one click verb, no second rendering path (candybar-build-2s5).
const buildWatch = makeBuildWatch({
  entryUrl: import.meta.url,
  intervalMs: BIN_CHECK_INTERVAL_MS,
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

// The parsed memory budget (bytes); set first thing in runDaemon.
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
  // armLimits and the boot line.
  // [LAW:single-enforcer] Refused through the same death funnel as every other
  // boot failure. A synchronous throw here is NOT uncaught — it lands in
  // index.ts's catch, whose stderr the detached spawn discards — so the one
  // line that says why the daemon never came up would go nowhere.
  try {
    budgetBytes = rssLimitBytes(process.env);
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

  // [LAW:single-enforcer] Same death funnel as the signals and the RSS backstop:
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
  // onListening runs twice — double-arming the RSS backstop + watchers. Clear
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
      `heapCap=${Math.round(v8.getHeapStatistics().heap_size_limit / 1048576)}MB ` +
      `rssLimit=${Math.round(budgetBytes / 1048576)}MB`,
  );
  // [LAW:single-enforcer] This bind is the one process-wide fact that answers
  // "did an outage just end" — see resetSpawnBackoff's doc comment in
  // acquire.ts. Any consecutive-spawn backoff accumulated getting here no
  // longer applies once a daemon is actually serving.
  resetSpawnBackoff();
  armBinaryWatch();
  buildWatch.arm();
  armLimits();
  armOwnershipWatch(sockPath, boundRead.identity);
}

// --- socket-ownership self-check ---
//
// [LAW:single-enforcer] The sole enforcer of "serving implies owning the socket
// path over time" (brandon-daemon-lifecycle-2b3.2). Each interval it re-reads
// BOTH representations a displacer can touch — the path's kernel identity (still
// the inode we bound?) and the lease (still names our pid?) — and drains through
// the SAME shutdown funnel as signals, the RSS backstop, and the watchdog on
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

// --- binary-mtime self-restart ---
//
// If the daemon's compiled output changes on disk (rebuild, upgrade, edit),
// exit at the next sample so the next client respawns from the fresh code.
// Cheap (one statSync/min) and avoids the user having to manually kill the
// daemon during development. unref() so this timer doesn't hold the process alive.
function armBinaryWatch(): void {
  // Watch the resolved entry point, not the bin shim — npm run build updates
  // dist/index.mjs but the bin/cc-candybar shim never changes.
  const entryUrl = import.meta.url;
  const targets: string[] = [];
  if (entryUrl.startsWith("file://")) {
    targets.push(fileURLToPath(entryUrl));
  }
  // Also watch argv[1] as fallback (covers global installs, symlinks, etc.)
  if (process.argv[1]) targets.push(process.argv[1]!);

  const originalMtimes = new Map<string, number>();
  for (const t of targets) {
    try {
      originalMtimes.set(t, fs.statSync(t).mtimeMs);
    } catch {
      // File may not exist yet — skip it.
    }
  }
  if (originalMtimes.size === 0) return;

  const timer = setInterval(() => {
    for (const [t, originalMtime] of originalMtimes) {
      try {
        const nowMtime = fs.statSync(t).mtimeMs;
        if (nowMtime !== originalMtime) {
          dlog("info", `binary mtime changed (${t}); shutting down`);
          clearInterval(timer);
          shutdown(0);
          return;
        }
      } catch (e) {
        dlog("warn", `bin stat failed: ${(e as Error).message}`);
      }
    }
  }, BIN_CHECK_INTERVAL_MS);
  timer.unref();
}

// --- self-shutdown on RSS / age ---
let limits: LimitsHandle | null = null;
function armLimits(): void {
  limits = makeLimits(
    realLimitsDeps(stats.startedAt.getTime(), (code) => shutdown(code), {
      rssLimitBytes: budgetBytes,
    }),
  );
  limits.arm();
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

  // [LAW:no-ambient-temporal-coupling] respond owns the response→exit
  // ordering. exitAfterFlush (an exit code; null = stay up) is performed
  // by sock.end's completion callback, which Node invokes on 'finish' OR
  // 'error' — a total signal. A peer that vanished mid-flush still settles,
  // so the exit wish can never be stranded on a dead socket, and a live
  // peer always has the frame in the kernel buffer before process.exit
  // (unix-socket data survives writer exit). No fixed sleep stands between
  // respond and exit; the SIGKILL backstop inside shutdown() is the
  // unrelated last-resort safety.
  const respond = (resp: Response, exitAfterFlush: number | null): void => {
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
      sock.end(encodeFrame(resp), settle);
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
  const timer = setTimeout(() => {
    stats.requestsTimedOut++;
    respond(
      {
        ok: false,
        error: "request exceeded 200ms",
        code: "TIMEOUT",
        daemonV: PROTOCOL_VERSION,
      },
      null,
    );
  }, REQUEST_TIMEOUT_MS);

  const reader = makeFrameReader(
    (frame) => {
      void handleRequest(frame as Request)
        .then((r) => respond(r.resp, r.exitAfterFlush))
        .catch((err) => {
          dlog("error", `handler threw: ${err?.stack || err}`);
          respond(
            {
              ok: false,
              error: String(err?.message || err),
              code: "RENDER_FAILED",
              daemonV: PROTOCOL_VERSION,
            },
            null,
          );
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
      );
    },
  );

  sock.on("data", reader);
  sock.on("error", (err) => {
    dlog("warn", `socket error: ${err.message}`);
  });
  sock.on("close", () => {
    clearTimeout(timer);
    inFlight = Math.max(0, inFlight - 1);
    stats.inFlight = inFlight;
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
interface HandledRequest {
  resp: Response;
  exitAfterFlush: number | null;
}

const stay = (resp: Response): HandledRequest => ({
  resp,
  exitAfterFlush: null,
});

async function handleRequest(req: Request): Promise<HandledRequest> {
  if (
    !req ||
    typeof req !== "object" ||
    typeof (req as Request).v !== "number"
  ) {
    return stay({
      ok: false,
      error: "malformed request",
      code: "BAD_REQUEST",
      daemonV: PROTOCOL_VERSION,
    });
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
    };
  }

  if (req.kind === "shutdown") {
    return { resp: { ok: true, output: "" }, exitAfterFlush: 0 };
  }

  if (req.kind === "stats") {
    // [LAW:single-enforcer] Stats requests do NOT bump request counters —
    // observability shouldn't pollute the metric being observed.
    return stay({
      ok: true,
      stats: stats.snapshot({
        gitCache: gitService.getStats(),
        usageCache: usageStore.getStats(),
        renderCacheSize: renderCache.size,
        watchersActive: watcherRegistry.size(),
        nextRestartReason: limits?.describeNextRestart() ?? null,
      }),
    });
  }

  if (req.kind === "render") {
    stats.requestsTotal++;
    const t0 = Date.now();
    try {
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
      // [LAW:no-silent-fallbacks][LAW:types-are-the-program] Gate hard on
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
      if (req.cwd === "") {
        wireProblems.push("request 'cwd' is empty");
      }
      if (wireProblems.length > 0) {
        stats.requestsErrored++;
        dlog("warn", `BAD_REQUEST: ${wireProblems.join("; ")}`);
        return stay({
          ok: false,
          error: `malformed hookData: ${wireProblems.join("; ")}`,
          code: "BAD_REQUEST",
          daemonV: PROTOCOL_VERSION,
        });
      }
      const projectDir = req.hookData.workspace.project_dir;
      // [LAW:dataflow-not-control-flow] thread the *request's* cwd, not the
      // daemon's process.cwd(), so config resolution depends only on request
      // data — the daemon's own working directory must not influence output.
      const { configFile, unknownFlagsError } = parseRenderArgs(req.args);
      // [LAW:effects-at-boundaries] The load-config verb writes per-session
      // config overrides into SessionState; this is the one read point.
      const sessionId = req.hookData.session_id;
      const sessionConfigFile =
        sessionState.get(sessionId, SESSION_CONFIG_OVERRIDE_KEY) ?? configFile;
      const entry = renderCache.getOrCreate(
        projectDir,
        req.cwd,
        sessionConfigFile,
      );
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
      const hints = parseClientHints(req);
      const termCols = hints.termCols;
      const width = applyClaudeCodeReserve(termCols ?? DEFAULT_TERMINAL_WIDTH);
      const renderOpts: BuildLineOptions = { ...RENDER_OPTS_BASE, width };
      // [LAW:dataflow-not-control-flow] Two outcomes fall out of one rule:
      // body = state ? renderDsl(state) : "" ; output = body + icon
      // No special-case branches — same composition every render.
      let body = "";
      if (entry.state !== null) {
        // [LAW:one-source-of-truth] Every globals field resolved ONCE per
        // render, here — before the payload build, so the same struct feeds
        // BOTH the payload's `*.effective` fields (what a trigger label says)
        // AND renderOpts below (what actually renders). One resolution, two
        // readers, so a label can never disagree with the bar. The precedence
        // the resolver applies, and why each rung sits where it does, lives
        // with the chain (resolveEffectiveGlobals, and src/config/presets.ts).
        // Read alongside the config, from the same entry, in one statement —
        // which is exactly what the closure below claims about it.
        const presetRootOps = entry.state.presetRootOps;
        const effective: EffectiveGlobals = resolveEffectiveGlobals(
          entry.state.config,
          (key: string) => sessionState.get(req.hookData.session_id, key),
          // [LAW:one-source-of-truth] brandon-layout-edit-2gc.5 — read from
          // THIS entry's own presetRootOps (the record that fed the SAME
          // reload that produced entry.state.config), never a fresh
          // loadOverrides() here — a second read could race a concurrent
          // write and disagree with the tree that actually rendered. That is
          // why it arrives as a closure over this entry rather than being
          // looked up inside the resolver.
          (preset: string) => presetIsCustomized(presetRootOps, preset),
        );
        const payload = await buildRenderPayload(
          req.hookData,
          payloadDeps,
          req.cwd,
          entry.state.neededInputPaths,
          effective,
          hints,
        );
        // [LAW:one-source-of-truth][LAW:dataflow-not-control-flow] basePalette
        // is derived from the same effective theme resolved above — so a theme
        // click recolors the whole bar on the next render. Not frozen on the
        // cache entry (one entry serves many sessions). paletteForThemeName
        // memoizes, so the per-render cost is one Map lookup once the theme is
        // warm.
        const basePalette = paletteForThemeName(effective.theme);
        // [LAW:one-source-of-truth] Every renderOpts field below reuses the
        // SAME `effective` struct the payload was just built from — no second
        // `?? DEFAULT_X` computation to drift from it.
        renderOpts.style = effective.style;
        // The `plain` joiner's cell separator. Assigned unconditionally like
        // every field around it: `undefined` is a value pickJoiner already
        // reads as "PlainJoiner's own default", not an absence to branch on.
        renderOpts.separator = effective.separator;
        renderOpts.wrap = effective.autoWrap;
        renderOpts.padding = effective.padding;
        renderOpts.charset = effective.charset;
        renderOpts.colorCompatibility = effective.colorCompatibility;
        // [LAW:single-enforcer] renderDsl internally calls
        // `registry.applyInput(payload)` as its first step (see step 1 in
        // src/dsl/render.ts). The daemon must not pre-apply — doing so
        // would run the MobX action twice per render and clear last_error
        // diagnostics on the round trip.
        body = renderDsl(
          entry.state.config,
          entry.state.compiled,
          entry.state.store,
          entry.state.registry,
          payload,
          basePalette,
          renderOpts,
          // [LAW:single-enforcer] The per-segment StripCell sink for the
          // `debug segments` projection. Its identity stays stable for the
          // cache entry's lifetime; renderDsl clears + repopulates it
          // in place. Cells are cheap (already computed during the render);
          // the per-segment ANSI serialization happens lazily inside the
          // debug handler so normal renders pay no extra serializer cost.
          { perSegmentSink: entry.state.lastRenderCellsBySegment },
          {
            look: lookKeyByName(entry.state.config.looks, effective.look),
            preset: effective.preset,
          },
        );
      }
      // [LAW:one-source-of-truth] Consume the transient click error written by
      // dispatch on partial/total effect failure, then clear it so it shows
      // exactly once. Only called when non-null to avoid a no-op persist+MobX
      // tick on every render.
      const clickError = sessionState.get(
        req.hookData.session_id,
        "click.error",
      );
      if (clickError)
        sessionState.clear(req.hookData.session_id, "click.error");
      const combinedError =
        [unknownFlagsError, entry.lastError, clickError]
          .filter(Boolean)
          .join("\n") || null;
      // [LAW:one-source-of-truth] The daemon-wide build verdict joins the
      // per-config warning on the one warning channel, the way the click
      // error joins the per-config error above. It goes first: a stale
      // bundle undermines every config, and leading keeps its two rows
      // inside the diagnostic row cap whatever the config adds.
      const combinedWarning =
        [buildWatch.warning(), entry.lastWarning].filter(Boolean).join("\n") ||
        null;
      const output = composeWithDiagnostics(
        body,
        combinedError,
        combinedWarning,
      );
      const ms = Date.now() - t0;
      const g = gitService.getStats();
      const u = usageStore.getStats();
      dlog(
        "info",
        `render sid=${req.hookData.session_id ?? "?"} took=${ms}ms termCols=${termCols ?? "?"} width=${width} git=${g.size}/${g.hits}h/${g.misses}m usage=${u.size}/${u.hits}h/${u.misses}m err=${combinedError ? "Y" : "N"} warn=${combinedWarning ? "Y" : "N"}`,
      );
      return stay({ ok: true, output: output + "\n" });
    } catch (e) {
      stats.requestsErrored++;
      throw e;
    }
  }

  if (req.kind === "click") {
    return stay(await handleClick(req.verb, req.value));
  }

  if (req.kind === "debug") {
    // [LAW:single-enforcer] One trust-boundary check at the wire edge —
    // `what` is untrusted JSON. isDebugWhat narrows it to the discriminated
    // union the introspector consumes; an invalid value short-circuits
    // here, not deep inside buildDebugSnapshot.
    if (!isDebugWhat(req.what)) {
      return stay({
        ok: false,
        // [LAW:errors-context-in-errors] Include the allowed values so a
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
    // firstPopulatedState iterates existing entries only; it does NOT
    // create a fresh one, so debug introspection never has the side effect
    // of standing up a new (projectDir=undefined) cache entry tied to the
    // daemon's own process.cwd(). A future debug-target selector would
    // thread (projectDir, cwd) through the wire.
    const dbgEntry = renderCache.firstPopulatedState();
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
                    dbgEntry.config.globals.charset ?? DEFAULT_CHARSET,
                    dbgEntry.config.globals.colorCompatibility ??
                      DEFAULT_COLOR_COMPATIBILITY,
                  )
                : EMPTY_RENDER_MAP,
          };
    return stay({ ok: true, debug: buildDebugSnapshot(req.what, dbgState) });
  }

  return stay({
    ok: false,
    error: "unknown kind",
    code: "BAD_REQUEST",
    daemonV: PROTOCOL_VERSION,
  });
}

// --- diagnostics composition ---
//
// [LAW:no-silent-fallbacks] Bad config can't quietly degrade output. The
// render pipeline carries two independent diagnostic channels:
//   error   — load-fatal: parse/validation failed; bar is last-known-good
//             or empty. Rendered red.
//   warning — advisory: load succeeded but something needs attention (e.g.
//             same-location .json5 + .json collision). Rendered amber.
// Either way the failure is visible at the point of impact, and each
// channel has its own click verb (show-config-error / show-config-warning)
// so the operator can copy the message to clipboard for inspection.
//
// [LAW:one-type-per-behavior] Two severities → two channels. The
// composer's signature carries both; severity is encoded in WHICH
// argument is non-null, not in a string prefix or a tag inside the
// message. The two icons render independently — both can show at once.
//
// [LAW:types-are-the-program] The diagnostic's visible text IS (a
// projection of) the underlying message — not a constant label that hides
// the content behind a click. The leading ⚠ + background color carry
// severity; the rest of the cell is the actual error/warning, sanitized
// and clipped to a single-line budget. A label divorced from the message
// would be the type lying about what's in the channel.
// [LAW:one-source-of-truth] Style constants come from the shared leaf
// (src/render/diagnostic-style.ts) — the same visual identity the client's
// permanent glyph uses. Only the OSC-8 link plumbing is local here.
const OSC8_OPEN = "\x1b]8;;";
const OSC8_CLOSE = "\x1b]8;;\x1b\\";
const ST = "\x1b\\";

// [LAW:single-enforcer][LAW:no-silent-fallbacks] Parse render-path args with
// the standard util at the trust boundary. `--config <path>` is the sole
// valid render flag; every other flag is surfaced as a render-time
// diagnostic icon (caller composes it alongside config errors). The
// `--config` value is `~`-expanded here, so every consumer downstream
// receives a literal path — no caller has to remember to expand it.
//
// `tokens: true, strict: false, allowPositionals: true` together let the
// parser emit a token entry for every flag (known or unknown) without
// throwing on unknown ones, and without mis-classifying their values as
// positionals.
function parseRenderArgs(args: string[]): {
  configFile: string | undefined;
  unknownFlagsError: string | null;
} {
  const { values, tokens } = parseArgs({
    args: args.slice(1), // skip binary path
    options: { config: { type: "string" } },
    strict: false,
    tokens: true,
    allowPositionals: true,
  });
  const unknown = [
    ...new Set(
      (tokens ?? [])
        .filter(
          (t): t is Extract<typeof t, { kind: "option" }> =>
            t.kind === "option" && t.name !== "config",
        )
        .map((t) => `--${t.name}`),
    ),
  ];
  const rawConfig = values.config as string | undefined;
  return {
    configFile: rawConfig === undefined ? undefined : expandHome(rawConfig),
    unknownFlagsError:
      unknown.length > 0 ? `Unknown flags: ${unknown.join(", ")}` : null,
  };
}

// Per-line visible budget and max rows for multi-line diagnostic blocks.
// Messages from the config validator (formatIssues) are already structured
// as one line per issue, so splitting there is the natural unit of display.
// Deliberately decoupled from DEFAULT_TERMINAL_WIDTH: that constant means
// "raw terminal cols we assume" and is reserved-against before reaching the
// renderer; this one is a direct visible-char cap on already-rendered
// diagnostic text. They happen to share the value 120 today but have
// different semantic intents.
const MAX_DIAGNOSTIC_LINE_LEN = 120;
const MAX_DIAGNOSTIC_LINES = 8;

function makeDiagnosticLink(
  verb: typeof VERB_SHOW_CONFIG_ERROR | typeof VERB_SHOW_CONFIG_WARNING,
  message: string,
  bg: string,
  fg: string,
): string {
  // Full message in the OSC-8 URL (clipboard-copy on click) — truncation
  // only affects what is visible, never what is accessible. [LAW:single-enforcer]
  // The click URL is born through effectsUrl like every other click — one
  // single-effect dispatch list, no second URL-format in the codebase.
  const url = effectsUrl([{ verb, args: [message] }]);
  // [LAW:dataflow-not-control-flow] Split on natural line boundaries from
  // the source message (config validator emits one issue per line), sanitize
  // each line individually, then render each as a separate styled row.
  // This preserves structured multi-line output instead of collapsing N
  // issues into a single truncated string the user cannot read.
  const lines = message
    .split(/\r\n|\r|\n/)
    .map((l) => sanitizeAndTruncate(l, MAX_DIAGNOSTIC_LINE_LEN))
    .filter(Boolean)
    .slice(0, MAX_DIAGNOSTIC_LINES);
  if (lines.length === 0) return "";
  const first = `${OSC8_OPEN}${url}${ST}${bg}${fg} ⚠ ${lines[0]} ${ANSI_RESET}${OSC8_CLOSE}`;
  const rest = lines
    .slice(1)
    .map(
      (l) =>
        `${OSC8_OPEN}${url}${ST}${bg}${fg}   ${l} ${ANSI_RESET}${OSC8_CLOSE}`,
    );
  return [first, ...rest].join("\n");
}

function composeWithDiagnostics(
  body: string,
  error: string | null,
  warning: string | null,
): string {
  // [LAW:dataflow-not-control-flow] Diagnostics list is data; the
  // composer walks it. Each non-null channel contributes one or more prefix
  // rows (makeDiagnosticLink returns a \n-joined multi-line block when the
  // message has natural line breaks). Order is error-first (more severe),
  // then warning, then body.
  const prefixes: string[] = [];
  if (error) {
    prefixes.push(
      makeDiagnosticLink(
        VERB_SHOW_CONFIG_ERROR,
        error,
        DIAGNOSTIC_ERROR_BG,
        DIAGNOSTIC_ERROR_FG,
      ),
    );
  }
  if (warning) {
    prefixes.push(
      makeDiagnosticLink(
        VERB_SHOW_CONFIG_WARNING,
        warning,
        DIAGNOSTIC_WARNING_BG,
        DIAGNOSTIC_WARNING_FG,
      ),
    );
  }
  if (prefixes.length === 0) return body;
  // No body → emit the diagnostic strip alone (startup-error case). Body
  // present → prepend on its own line so it's visible regardless of bar
  // width. Multiple diagnostics stack on their own lines.
  const strip = prefixes.join("\n");
  return body ? `${strip}\n${body}` : strip;
}

// --- click verb dispatch ---
// [LAW:dataflow-not-control-flow] The dispatcher is a table lookup. The verb
// table (src/daemon/verbs/index.ts) is the single canonical list of supported
// verbs — handlers live there, the dispatcher only routes.
//
// [LAW:types-are-the-program] The error class on the throw determines the
// response code: BadVerbArgs (invalid input shape) becomes BAD_REQUEST; any
// other Error (operational failure) becomes RENDER_FAILED. No string matching.

const verbCtx = { sessionState, dlog };

// [LAW:single-enforcer] Style + color compatibility shared by the render
// path and the lazy debug-side per-segment serializer. Per-request `width`
// is composed on top at the wire boundary (handleRequest("render")) and
// passed through as renderOpts. Debug serialization composes its own
// per-segment opts with width: Number.POSITIVE_INFINITY since each segment
// is rendered standalone (wrap doesn't apply to a one-segment projection).
const RENDER_OPTS_BASE = {
  style: "powerline" as const,
  colorCompatibility: DEFAULT_COLOR_COMPATIBILITY,
  wrap: DEFAULT_WRAP,
  padding: DEFAULT_PADDING,
  charset: DEFAULT_CHARSET,
};
const DEBUG_RENDER_OPTS: BuildLineOptions = {
  ...RENDER_OPTS_BASE,
  width: Number.POSITIVE_INFINITY,
};

// [LAW:no-defensive-null-guards] Reused empty map for the `vars` /
// `config` debug projections — they don't read lastRenderBySegment but
// the DaemonDslState type requires the field.
const EMPTY_RENDER_MAP = new Map<string, string>();

// [LAW:one-source-of-truth] The joiner glyph vocabulary and the color depth
// are serialization-time choices, and both are config-only (no SessionState
// half) — so the faithful values are fully derivable from the sampled entry's
// config, unlike style, whose live session-over-config resolution needs a
// session a debug request doesn't carry. The caller threads the
// entry-resolved values; this serializer never re-defaults them.
function serializeSegmentCells(
  cells: ReadonlyMap<string, readonly RichText[]>,
  charset: Charset,
  colorCompatibility: ColorCompatibility,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, segCells] of cells) {
    out.set(
      name,
      renderStripCells(segCells, {
        ...DEBUG_RENDER_OPTS,
        charset,
        colorCompatibility,
      }),
    );
  }
  return out;
}

// [LAW:single-enforcer] The payload-builder dependency bundle. One value
// passed through every render — the data the daemon brings to each tick.
const payloadDeps = {
  gitProvider: gitService,
  usageStore,
  contextProvider,
  metricsProvider,
  tmuxService,
  // [LAW:single-enforcer] buildRenderPayload is the one log site for the
  // outcome-carrying provider lanes (git, cache).
  log: dlog,
  // [LAW:single-enforcer] The daemon's wall clock — the same instant source
  // the rate-limit ETA projection and the template's reset countdown read.
  clock: () => new Date(),
};

function handleClick(verb: string, value: string): Response {
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
    handler(value, verbCtx);
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
