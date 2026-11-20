import { systemRegion } from "../utils/region.js";
import fs from "node:fs";
import net from "node:net";
import v8 from "node:v8";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  daemonPaths,
  ensureSocketParentSafe,
  leasePathFor,
  type DaemonPaths,
} from "./paths";
import { arbitrateSocket, readLease, writeLease } from "./socket-lease";
import {
  makeOwnershipWatch,
  readSocketIdentity,
  type SocketIdentity,
} from "./socket-ownership";
import { readOwnStartTime, liveness, systemProbe } from "./process-fingerprint";
import { admitDaemon, realBreakerDeps, removeEntry } from "./fork-bomb-breaker";
import { bakedDigest } from "./build-currency";
import { DaemonLog } from "./log";
import type { LogLevel } from "../utils/logger";
import { runTeardown } from "../utils/teardown.js";
import type { World } from "../host";
import {
  createDaemon,
  type PreparedDaemon,
  type RunningBundle,
} from "./daemon.js";
import { MAIN_RENDERER } from "./foundations/renderer-name.js";
import { productionAdapters } from "./production-adapters.js";
import { handleConnection } from "./connection.js";
import { PROTOCOL_VERSION } from "./foundations/protocol";
import { heapCapMb, memoryLimitBytes } from "./limits";
import { processPort } from "./renderer-process.js";
import { mb } from "./foundations/memory-limit";
import { armParentWatchdog, anchorFromEnv } from "./parent-watchdog";
import { resetSpawnBackoff } from "./acquire";

// Daemon entry point. Tries to bind the Unix socket — atomic bind() is the
// single-instance enforcer (two daemons cannot both bind the same path; the
// kernel makes duplicate-daemon unrepresentable). Listens for one request per
// connection. Any uncaught error exits non-zero; the next client obtains a
// fresh daemon via a later ordinary statusline tick in src/daemon/acquire.ts.
// [LAW:one-source-of-truth] Our own kernel start-time, read once at startup and
// stamped into our lease so a future daemon's arbitration can prove whether our
// pid still names THIS process or a recycled ghost (process-fingerprint.ts).
// null when this host cannot fingerprint (no `ps`) — readers then fall back to
// kill(pid,0), no worse than before the fingerprint existed.
// Set at boot, before anything that names this process reads it.
let myStartTime = "";

// The registry path this daemon claimed in the fork-bomb breaker's population
// registry (fork-bomb-breaker.ts), or null when exempt (the canonical
// production socket) or never reached (refused before claiming one). Released
// on shutdown so a graceful exit frees its slot immediately rather than
// waiting for the next boot's stale-sweep.
let breakerRegistryPath: string | null = null;

// [LAW:effects-at-boundaries] The daemon the process owns during bind and
// service. Close is available even when bind never succeeds.
let prepared: PreparedDaemon | null = null;
// Shutdown waits for admission to hand over any registry path it claimed.
let startup: Promise<void> | null = null;

// [LAW:effects-at-boundaries] The process this daemon is: the world its main
// handed it, every path it touches (parsed from that world's host here and
// nowhere below), and the log those paths name. Fixed once by `runDaemon`, before anything that can fail.
interface DaemonProcess {
  readonly world: World;
  readonly paths: DaemonPaths;
  readonly log: DaemonLog;
}
let thisProcess: DaemonProcess | null = null;

function daemonProcess(): DaemonProcess {
  if (thisProcess === null) throw new Error("runDaemon has not started");
  return thisProcess;
}

function serverLog(level: LogLevel, msg: string): void {
  daemonProcess().log.log(level, msg);
}

// [LAW:one-source-of-truth] The daemon's one read of the running entry's identity:
// `import.meta.url` stays in this shell, which a jest worker never loads.
function runningBundle(): RunningBundle {
  const path = fileURLToPath(import.meta.url);
  return {
    digest: bakedDigest(),
    path,
    node: [process.execPath, ...process.execArgv],
    // Watch the resolved entry point, not the bin shim — a build updates
    // dist/index.mjs but the bin/cc-candybar shim never changes — and argv[1]
    // beside it (global installs, symlinks). One target per path: run as
    // `node dist/index.mjs`, both name one file.
    targets: [
      ...new Set([path, ...(process.argv[1] ? [process.argv[1]] : [])]),
    ],
  };
}

// The entry this process runs, which its renderer's process runs too: the
// bundle, or the source a test's loader compiles, where the module's own file
// is no entry. [LAW:no-silent-failure] A daemon is always run from one.
function processEntry(): string {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("the daemon was run with no entry");
  return entry;
}

export function runDaemon(world: World): void {
  const paths = daemonPaths(world.host);
  thisProcess = { world, paths, log: new DaemonLog(paths.log, world.clock) };
  // Catch-alls log + exit so the supervisor (the next client) can restart us.
  // [LAW:no-defensive-null-guards] These are *trust boundaries* — we are
  // catching all of unknown space, not skipping known optional values.
  // [LAW:single-enforcer] Registered FIRST, before any of the startup calls
  // below that can throw (admitDaemon's ensureDirSafe/writeEntry,
  // ensureSocketParentSafe) — otherwise an early throw is a raw unhandled
  // exception (stack trace to stderr, bypassing the clean shutdown(1) log +
  // SIGKILL backstop) rather than funneling through the same death path as
  // every other failure mode.
  process.on("uncaughtException", (err) => {
    serverLog("error", `uncaughtException: ${err.stack || err.message}`);
    shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    serverLog("error", `unhandledRejection: ${String(reason)}`);
    shutdown(1);
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      serverLog("info", `received ${sig}, shutting down`);
      shutdown(0);
    });
  }

  // [LAW:single-enforcer] Refused through the same death funnel as every other
  // boot failure: the detached spawn discards stderr, so the one line that says
  // why the daemon never came up would otherwise go nowhere.
  startup = boot().catch(refuseBoot);
}

function refuseBoot(err: unknown): void {
  serverLog("error", `refusing to boot: ${inspect(err)}`);
  shutdown(1);
}

async function boot(): Promise<void> {
  // [LAW:effects-at-boundaries] The memory budget is parsed here, before any
  // resource is committed — a malformed override is refused before the breaker
  // registers us, before the bind, before the lease, and before a `daemon up`
  // line could claim a boot that is about to die. Parsed once, threaded into
  // the limits and the boot line.
  const { world, paths, log: daemonLog } = daemonProcess();
  const { host } = world;
  const memoryLimit = memoryLimitBytes(host.env);

  // [LAW:single-enforcer] The fork-bomb circuit breaker runs FIRST among the
  // resource-committing steps (no dir created, no socket touched, no session
  // state loaded) — the whole point of a load-independent backstop is that it
  // holds even when everything downstream of it is thrashing. Own start-time
  // must be read first: it is both this check's identity and the lease's
  // fingerprint later, so it is read exactly once and threaded through both
  // (see realBreakerDeps' doc comment).
  myStartTime = await readOwnStartTime(
    process.pid,
    systemProbe(world.launcher).startTime,
  );
  if (shuttingDown) return;
  const admission = await admitDaemon(
    realBreakerDeps(world, myStartTime, paths.registry, (message) =>
      serverLog("warn", message),
    ),
  );
  if (!admission.decision.allow) {
    serverLog(
      "warn",
      `fork-bomb breaker: ${admission.decision.reason}; refusing to boot`,
    );
    shutdown(1);
    return;
  }
  breakerRegistryPath = admission.registryPath;
  if (shuttingDown) return;

  fs.mkdirSync(paths.state, { recursive: true });
  // [LAW:single-enforcer] Verify the socket parent is uid==me + mode 0700 +
  // not a symlink before we bind. Without this check, a same-host attacker
  // could pre-create the predictable `/tmp/cc-candybar-<uid>` directory and
  // squat the socket name. The check applies regardless of CC_CANDYBAR_SOCKET
  // location — every bind path goes through the same trust precondition.
  // No symmetric client-side check: the daemon is the sole creator, so a
  // successful bind already proves the parent is trusted. Failure here surfaces
  // as a daemon exit; the client falls back to the last cached render.
  ensureSocketParentSafe(paths.socket);

  // Prepare before binding. The socket winner loads prior state in onListening.
  const daemon = createDaemon({
    region: systemRegion(),
    rendererName: MAIN_RENDERER,
    rendererEntry: processEntry(),
    ...productionAdapters(paths, daemonLog, world.clock),
    // [LAW:one-type-per-behavior] The renderer runs in a process of its own,
    // launched through the process's launcher: the daemon's close aborts its
    // own launches before the renderer's last steps of it.
    renderer: processPort({
      launcher: world.launcher,
      cwd: paths.state,
      heapCapMb: heapCapMb(host.env),
    }),
    bundle: runningBundle(),
    host,
    paths,
    memoryLimitBytes: memoryLimit,
    clock: world.clock,
    exit: shutdown,
  });
  prepared = daemon;
  // [LAW:single-enforcer] Same death funnel as the signals and the memory backstop:
  // the watchdog calls shutdown(0), it never exits on its own. A production
  // daemon has no spawner to outlive (env unset) and arms an inert handle; only
  // a test-spawned daemon is anchored, so this is invisible to the real daemon.
  armParentWatchdog({
    clock: world.clock,
    anchor: anchorFromEnv(host.env),
    probe: systemProbe(world.launcher),
    onOrphaned: (reason) => {
      serverLog("info", `parent watchdog: ${reason}; shutting down`);
      shutdown(0);
    },
  });

  const server = net.createServer();

  // [LAW:single-enforcer] The atomic bind() is the daemon-singleton enforcer.
  // Two daemons cannot both bind the same Unix socket path; the kernel makes
  // duplicate-daemon unrepresentable. The pidfile is diagnostic only — never
  // load-bearing for exclusion.
  bindOrAttachAndExit(daemon, server, paths.socket, /* retried */ false);
}

// [LAW:dataflow-not-control-flow] One operation ("bring this server up or
// discover an existing one"). The bind result is the data that decides the
// next step; callers do not get to choose whether to spawn.
function bindOrAttachAndExit(
  daemon: PreparedDaemon,
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
      serverLog("error", `server error: ${err.message}`);
      shutdown(1);
      return;
    }
    if (retried) {
      // Lost a rebind race with another duplicate. The kernel arbitrated; we
      // are the loser. Exit cleanly so the winner serves.
      serverLog("info", "lost rebind race; another daemon is alive — exiting");
      shutdown(0);
      return;
    }
    handleAddressInUse(daemon, server, sockPath).catch(refuseBoot);
  });
  server.listen(sockPath, () => onListening(daemon, server, sockPath));
}

// [LAW:one-source-of-truth] EADDRINUSE arbitration consults the socket-derived
// lease, NEVER a connect probe. The path already exists (a live daemon, or a
// stale file from an ended one); whether the lease's owner identity (pid and
// start-time) is still a live process decides which (the liveness fold). A
// concurrent recoverer is another process, so no liveness read was ever atomic
// with the unlink, and this runs once per bind attempt in one daemon, so the
// await on the start-time read adds no in-process entrant and needs no
// re-check: the lease and the ownership self-check are what recover a lost
// race.
//
// [LAW:effects-at-boundaries] The decision is the arbitrateSocket fold
// over the lease read + the injected probe; the kill / unlink / rebind effects
// are performed here at the edge.
async function handleAddressInUse(
  daemon: PreparedDaemon,
  server: net.Server,
  sockPath: string,
): Promise<void> {
  // [LAW:one-source-of-truth] Derive the lease from the SAME sockPath threaded
  // through unlink + rebind below, not the re-derived global — one identity
  // source for the whole arbitration.
  const decision = await arbitrateSocket(
    readLease(leasePathFor(sockPath)),
    process.pid,
    (pid, startTime) => liveness(pid, startTime, systemProbe(daemon.launcher)),
  );
  if (shuttingDown) return;
  if (decision.kind === "attach-and-exit") {
    serverLog("info", `EADDRINUSE: ${decision.reason} — exiting`);
    shutdown(0);
    return;
  }
  serverLog(
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
      serverLog(
        "error",
        `cannot unlink stale socket ${sockPath}: ${(e as Error).message}`,
      );
      shutdown(1);
      return;
    }
  }
  bindOrAttachAndExit(daemon, server, sockPath, /* retried */ true);
}

function onListening(
  daemon: PreparedDaemon,
  server: net.Server,
  sockPath: string,
): void {
  if (shuttingDown) return;
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
    serverLog(
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
  const leaseFailure = writeLeaseFile(sockPath);
  if (leaseFailure !== null) {
    refuseBoot(new Error(`lease write failed: ${leaseFailure}`));
    return;
  }
  try {
    fs.chmodSync(sockPath, 0o600);
  } catch (e) {
    serverLog("warn", `chmod socket failed: ${(e as Error).message}`);
  }
  // [LAW:no-ambient-temporal-coupling] A socket becomes a request entry
  // point only after its owner loads the renderer and arms production work.
  const served = daemon.serve();
  served.arm();
  if (shuttingDown) return;
  server.on("connection", (sock) => handleConnection(served, sock));
  serverLog(
    "info",
    // [FRAMING:representation] Report the heap cap V8 actually applied (the
    // territory), not the flag the spawner meant to pass (the map) — the one
    // question a silent SIGABRT crash-loop leaves open is "which cap was live".
    `daemon up: pid=${process.pid} v=${PROTOCOL_VERSION} sock=${sockPath} ` +
      `heapCap=${mb(v8.getHeapStatistics().heap_size_limit)}MB ` +
      `memoryLimit=${mb(served.memoryLimitBytes)}MB`,
  );
  // [LAW:single-enforcer] This bind is the one process-wide fact that answers
  // "did an outage just end" — see resetSpawnBackoff's doc comment in
  // acquire.ts. Any consecutive-spawn backoff accumulated getting here no
  // longer applies once a daemon is actually serving.
  resetSpawnBackoff(daemonProcess().paths.spawnBackoff);
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
    me: { pid: process.pid, startTime: myStartTime },
    readIdentity: () => readSocketIdentity(sockPath),
    readLease: () => readLease(leasePathFor(sockPath)),
    shutdown: (code) => shutdown(code),
    log: serverLog,
    clock: daemonProcess().world.clock,
  }).arm();
}

// --- socket-ownership lease ---
//
// [LAW:one-source-of-truth] The lease is the authority for socket ownership —
// its owner identity (pid and start-time) is what the next daemon's EADDRINUSE
// arbitration consults (handleAddressInUse). Exclusion RIGHT NOW is still the atomic bind()
// in bindOrAttachAndExit(); the lease answers the separate question "may I
// destroy this existing path" over time. It also carries the same diagnostic
// fields the old pidfile did, so one file serves both roles.
//
// Overwrite-on-write (no EEXIST check). We only reach onListening after winning
// the bind, so whatever stale lease a dead owner left is ours to replace.
// [LAW:no-silent-failure] A write that fails refuses the boot: the lease on disk
// is still the predecessor's, so serving on would end at the first ownership
// self-check as a "displacement" that never happened. Returns the reason, or
// null once the lease names us.

function writeLeaseFile(sockPath: string): string | null {
  return writeLease(leasePathFor(sockPath), {
    pid: process.pid,
    version: PROTOCOL_VERSION,
    binPath: process.argv[1],
    startTime: myStartTime,
  });
}

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
  daemonProcess().world.clock.after("exit backstop", 500, () =>
    process.kill(process.pid, "SIGKILL"),
  );
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
  daemonProcess().world.clock.detach("daemon close", () => closeThenExit(code));
}

// [LAW:no-ambient-temporal-coupling] The daemon's close awaits the renderer's
// steps of its teardown, so every click ahead of the close lands before the
// abort and the session state flushes last, whichever process the renderer runs in; the
// exit follows the close, still inside the backstop armed above.
async function closeThenExit(code: number): Promise<void> {
  // [LAW:no-silent-failure][LAW:dataflow-not-control-flow] Every step runs,
  // in order, and one that throws is said by name without skipping the rest:
  // a close that failed still gives up the registry slot. An unhandled
  // rejection here would only reach a shutdown already under way, and the
  // backstop's SIGKILL would end the process in place of the exit below.
  await runTeardown(
    [
      ["finish admission", () => startup ?? undefined],
      ["close", () => prepared?.close()],
      // [LAW:single-enforcer] The lease stays, as the socket path does (writeLease).
      [
        "registry release",
        () => {
          if (breakerRegistryPath !== null)
            removeEntry(breakerRegistryPath, (p) => fs.unlinkSync(p));
        },
      ],
    ],
    (_level, message) => serverLog("error", `shutdown ${message}`),
  );
  // The log writes every line still waiting as the process exits (log.ts), so
  // the death line lands without a flush here.
  process.exit(code);
}
