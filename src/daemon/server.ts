import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { daemonDir, pidPath, socketPath, sessionStatePath } from "./paths";
import { dlog, closeLog } from "./log";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
  sanitizeTermCols,
} from "./protocol";
import type { Request, Response } from "./protocol";
import { GitDataProvider } from "./cache/git";
import { CachedUsageProvider } from "./cache/usage";
import { RenderCache } from "./cache/render";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
import { makeLimits, realLimitsDeps, type LimitsHandle } from "./limits";
import { SessionState } from "./session-state";
import { FileSessionStorage } from "./session-state-file";
import { VERBS, BadVerbArgs } from "./verbs";
import { validateHookData } from "../utils/schema-validator.js";
import { setLaunchStats } from "../proc/launch";
import { buildDebugSnapshot } from "./debug";
import { DEBUG_WHATS, isDebugWhat } from "./debug-types";
import { renderDslLine } from "../dsl/render.js";
import { buildRenderPayload } from "./render-payload.js";
import { TodayProvider } from "../segments/today.js";
import { ContextProvider } from "../segments/context.js";
import { MetricsProvider } from "../segments/metrics.js";
import { BlockProvider } from "../segments/block.js";
import { TmuxService } from "../segments/tmux.js";

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
const usageProvider = new CachedUsageProvider();
// [LAW:locality-or-seam] Constructed ephemeral so importing this module (CLI
// relay, subcommands) does no disk I/O. The daemon binds the file-backed
// storage in runDaemon(), making it the sole reader/writer of the state file.
const sessionState = new SessionState();
// [LAW:one-source-of-truth] One provider per data shape, shared across every
// render in this daemon. The render cache owns DSL-state-per-config; these
// providers serve the augmented payload that flows through every render.
const todayProvider = new TodayProvider();
const contextProvider = new ContextProvider();
const metricsProvider = new MetricsProvider();
const blockProvider = new BlockProvider();
const tmuxService = new TmuxService();
const renderCache = new RenderCache({
  gitService,
  sessionState,
  watchers: watcherRegistry,
});

const REQUEST_TIMEOUT_MS = 200;
const BIN_CHECK_INTERVAL_MS = 60 * 1000;

// Daemon entry point. Tries to bind the Unix socket — atomic bind() is the
// single-instance enforcer (two daemons cannot both bind the same path; the
// kernel makes duplicate-daemon unrepresentable). Listens for one request per
// connection. Any uncaught error exits non-zero; the next client obtains a
// fresh daemon via obtainDaemonKick() (fire-and-forget caller) or
// obtainDaemon() (caller waits for readiness) in src/daemon/acquire.ts.
export function runDaemon(): void {
  fs.mkdirSync(daemonDir(), { recursive: true });

  // Bind disk persistence now that we know we are the daemon process — load
  // prior session state and become the sole writer of the state file.
  sessionState.useStorage(
    new FileSessionStorage(sessionStatePath(), 500, dlog),
  );

  // Catch-alls log + exit so the supervisor (the next client) can restart us.
  // [LAW:no-defensive-null-guards] These are *trust boundaries* — we are
  // catching all of unknown space, not skipping known optional values.
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
    void handleAddressInUse(server, sockPath);
  });
  server.listen(sockPath, () => onListening(sockPath));
}

async function handleAddressInUse(
  server: net.Server,
  sockPath: string,
): Promise<void> {
  // EADDRINUSE: either a live daemon (we are a duplicate — exit), or a stale
  // socket file from a crashed prior daemon (unlink + rebind).
  const alive = await isSocketAlive(sockPath);
  if (alive) {
    dlog("info", "another daemon is listening on socket — exiting");
    process.exit(0);
  }
  // Race-window guard: between our first `isSocketAlive` returning false and
  // our `unlinkSync` running, another concurrent recoverer could unlink+bind
  // the path. Without re-checking, our unlink would remove their *live*
  // socket, leaving two daemons (one orphaned-but-listening, one freshly
  // bound). Re-check immediately before unlink. If a live listener appeared
  // between checks, exit instead of stomping on it.
  if (await isSocketAlive(sockPath)) {
    dlog(
      "info",
      "race: another daemon claimed the socket during recovery — exiting",
    );
    process.exit(0);
  }
  dlog("warn", "stale socket from crashed daemon — unlinking and rebinding");
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

// [LAW:no-defensive-null-guards] Three-state outcome distinguishes
// "definitely no listener" from "probably alive but slow." Callers that
// might destroy state on "no listener" (the stale-socket unlink path) must
// treat "unknown" as alive to avoid stomping on a slow live daemon.
type SocketAliveness = "alive" | "dead" | "unknown";

function probeSocket(sockPath: string): Promise<SocketAliveness> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (result: SocketAliveness): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      resolve(result);
    };
    sock.once("connect", () => done("alive"));
    sock.once("error", (err) => {
      // Only these error codes definitively mean "no listener at this path":
      //   ECONNREFUSED — socket file present, kernel rejected connect
      //   ENOENT       — socket file absent
      //   ENOTSOCK     — path exists but isn't a socket
      // Anything else (EPERM, EACCES, EAGAIN, …) is ambiguous — assume the
      // daemon is alive to avoid destructive false negatives.
      const code = (err as NodeJS.ErrnoException).code;
      const dead =
        code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK";
      done(dead ? "dead" : "unknown");
    });
    // 50ms is generous; localhost AF_UNIX connect is sub-ms when a listener
    // exists. Timeout means "we couldn't tell" — treat as unknown so the
    // stale-socket recovery path doesn't unlink a live (but slow) daemon's
    // socket.
    timer = setTimeout(() => done("unknown"), 50);
    timer.unref();
  });
}

// Convenience: callers that just want "is something listening" treat
// "unknown" as alive (conservative — used by the EADDRINUSE attach branch).
async function isSocketAlive(sockPath: string): Promise<boolean> {
  const result = await probeSocket(sockPath);
  return result !== "dead";
}

function onListening(sockPath: string): void {
  try {
    fs.chmodSync(sockPath, 0o600);
  } catch (e) {
    dlog("warn", `chmod socket failed: ${(e as Error).message}`);
  }
  writePidfileDiagnostic();
  dlog(
    "info",
    `daemon up: pid=${process.pid} v=${PROTOCOL_VERSION} sock=${sockPath}`,
  );
  armBinaryWatch();
  armLimits();
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
    realLimitsDeps(stats.startedAt.getTime(), (code) => shutdown(code)),
  );
  limits.arm();
}

// --- diagnostic pidfile ---
//
// [LAW:one-source-of-truth] The pidfile is *diagnostic only*. It records who
// the running daemon is so `daemon-stats` can report it; it plays no role in
// exclusion. Exclusion is the atomic bind() in bindOrAttachAndExit().
//
// Overwrite-on-write (no EEXIST check). If a stale pidfile exists from a
// crashed prior daemon, we replace it. The bind() above already proved no
// other daemon is alive.

function writePidfileDiagnostic(): void {
  const payload = JSON.stringify({
    pid: process.pid,
    version: PROTOCOL_VERSION,
    binPath: process.argv[1],
    startedAt: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(pidPath(), payload, { mode: 0o600 });
    // [LAW:single-enforcer] writeFileSync's `mode` only applies when the file
    // is created. If a stale pidfile from a prior run was left with broader
    // permissions, the write above won't tighten them — chmod explicitly so
    // 0600 is the invariant regardless of prior state.
    fs.chmodSync(pidPath(), 0o600);
  } catch (e) {
    // Diagnostic only — failure does not block the daemon from serving.
    dlog("warn", `pidfile write failed: ${(e as Error).message}`);
  }
}

function removePidfileDiagnostic(): void {
  try {
    fs.unlinkSync(pidPath());
  } catch {}
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
  try {
    fs.unlinkSync(socketPath());
  } catch {}
  try {
    gitService.close();
  } catch (e) {
    dlog("warn", `gitService close failed: ${(e as Error).message}`);
  }
  try {
    usageProvider.close();
  } catch (e) {
    dlog("warn", `usageProvider close failed: ${(e as Error).message}`);
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
  removePidfileDiagnostic();
  closeLog();
  process.exit(code);
}

// --- per-connection handler ---

function handleConnection(sock: net.Socket): void {
  inFlight++;
  stats.inFlight = inFlight;
  let responded = false;

  const respond = (resp: Response): void => {
    if (responded) return;
    responded = true;
    try {
      sock.write(encodeFrame(resp));
    } catch {}
    sock.end();
  };

  // Per-request timeout protects the daemon from a single slow request
  // (e.g. a hung git call) blocking subsequent connections.
  const timer = setTimeout(() => {
    stats.requestsTimedOut++;
    respond({
      ok: false,
      error: "request exceeded 200ms",
      code: "TIMEOUT",
      daemonV: PROTOCOL_VERSION,
    });
  }, REQUEST_TIMEOUT_MS);

  const reader = makeFrameReader(
    (frame) => {
      void handleRequest(frame as Request)
        .then((r) => respond(r))
        .catch((err) => {
          dlog("error", `handler threw: ${err?.stack || err}`);
          respond({
            ok: false,
            error: String(err?.message || err),
            code: "RENDER_FAILED",
            daemonV: PROTOCOL_VERSION,
          });
        });
    },
    (err) => {
      dlog("warn", `frame parse failed: ${err.message}`);
      respond({
        ok: false,
        error: err.message,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
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

async function handleRequest(req: Request): Promise<Response> {
  if (
    !req ||
    typeof req !== "object" ||
    typeof (req as Request).v !== "number"
  ) {
    return {
      ok: false,
      error: "malformed request",
      code: "BAD_REQUEST",
      daemonV: PROTOCOL_VERSION,
    };
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
        `version mismatch: client=${req.v} > daemon=${PROTOCOL_VERSION}; binary likely upgraded — shutting down`,
      );
      setTimeout(() => shutdown(0), 50);
    } else {
      dlog(
        "info",
        `version mismatch: client=${req.v} < daemon=${PROTOCOL_VERSION}; client is stale — staying up`,
      );
    }
    return {
      ok: false,
      error: `protocol v${req.v} not supported (daemon at v${PROTOCOL_VERSION})`,
      code: "VERSION_MISMATCH",
      daemonV: PROTOCOL_VERSION,
    };
  }

  if (req.kind === "shutdown") {
    setTimeout(() => shutdown(0), 50);
    return { ok: true, output: "" };
  }

  if (req.kind === "stats") {
    // [LAW:single-enforcer] Stats requests do NOT bump request counters —
    // observability shouldn't pollute the metric being observed.
    return {
      ok: true,
      stats: stats.snapshot({
        gitCache: gitService.getStats(),
        usageCache: usageProvider.getStats(),
        renderCacheSize: renderCache.size,
        watchersActive: watcherRegistry.size(),
        nextRestartReason: limits?.describeNextRestart() ?? null,
      }),
    };
  }

  if (req.kind === "render") {
    stats.requestsTotal++;
    const t0 = Date.now();
    try {
      // [LAW:single-enforcer] One trust-boundary check for incoming hookData.
      // Divergences are logged, not thrown — rendering continues regardless.
      const { report } = validateHookData(req.hookData as unknown);
      for (const path of report.missingRequired) {
        dlog("warn", `schema: required field '${path}' absent in hookData`);
      }
      for (const { path, expected, got } of report.typeMismatches) {
        dlog(
          "warn",
          `schema: field '${path}' expected ${expected}, got ${got}`,
        );
      }
      for (const field of report.unknownTopLevelFields) {
        dlog(
          "info",
          `schema: unknown field '${field}' — Anthropic may have added it`,
        );
      }
      const projectDir = req.hookData.workspace?.project_dir;
      // [LAW:dataflow-not-control-flow] thread the *request's* cwd, not the
      // daemon's process.cwd(), so config resolution depends only on request
      // data — the daemon's own working directory must not influence output.
      const entry = renderCache.getOrCreate(req.args, projectDir, req.cwd);
      // [LAW:single-enforcer] Sanitize wire-supplied termCols here at the
      // trust boundary; sanitized but currently unused — terminal-width-aware
      // wrapping is a future BuildLineOptions extension (see strip.ts).
      // Sanitization stays at the boundary so when wrapping arrives, the
      // type is already correct.
      void sanitizeTermCols(req.termCols);
      // [LAW:dataflow-not-control-flow] Two outcomes fall out of one rule:
      // body = state ? renderDslLine(state) : "" ; output = body + icon
      // No special-case branches — same composition every render.
      let body = "";
      if (entry.state !== null) {
        const payload = await buildRenderPayload(
          req.hookData,
          payloadDeps,
          req.cwd,
          entry.state.config,
        );
        // [LAW:single-enforcer] renderDslLine internally calls
        // `registry.applyInput(payload)` as its first step (see step 1 in
        // src/dsl/render.ts). The daemon must not pre-apply — doing so
        // would run the MobX action twice per render and clear last_error
        // diagnostics on the round trip.
        body = renderDslLine(
          entry.state.config,
          entry.state.compiled,
          entry.state.store,
          entry.state.registry,
          payload,
          entry.state.basePalette,
          {
            style: "powerline",
            colorCompatibility: "truecolor",
          },
        );
      }
      const output = composeWithError(body, entry.lastError);
      const ms = Date.now() - t0;
      const g = gitService.getStats();
      const u = usageProvider.getStats();
      dlog(
        "info",
        `render sid=${req.hookData.session_id ?? "?"} took=${ms}ms git=${g.size}/${g.hits}h/${g.misses}m usage=${u.size}/${u.hits}h/${u.misses}m err=${entry.lastError ? "Y" : "N"}`,
      );
      return { ok: true, output: output + "\n" };
    } catch (e) {
      stats.requestsErrored++;
      throw e;
    }
  }

  if (req.kind === "click") {
    return handleClick(req.verb, req.value);
  }

  if (req.kind === "debug") {
    // [LAW:single-enforcer] One trust-boundary check at the wire edge —
    // `what` is untrusted JSON. isDebugWhat narrows it to the discriminated
    // union the introspector consumes; an invalid value short-circuits
    // here, not deep inside buildDebugSnapshot.
    if (!isDebugWhat(req.what)) {
      return {
        ok: false,
        // [LAW:errors-context-in-errors] Include the allowed values so a
        // CLI consumer (or operator) sees what is supported without
        // grep — same pattern as the set-state verb's unknown-key error
        // in src/daemon/verbs/state-validators.ts.
        error: `unknown debug 'what': ${String(req.what)} (have: ${DEBUG_WHATS.join(", ")})`,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      };
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
    const dbgState =
      dbgEntry === null
        ? null
        : {
            store: dbgEntry.store,
            registry: dbgEntry.registry,
            config: dbgEntry.config,
            compiled: dbgEntry.compiled,
            lastRenderBySegment: new Map<string, string>(),
          };
    return { ok: true, debug: buildDebugSnapshot(req.what, dbgState) };
  }

  return {
    ok: false,
    error: "unknown kind",
    code: "BAD_REQUEST",
    daemonV: PROTOCOL_VERSION,
  };
}

// --- error-icon composition ---
//
// [LAW:no-silent-fallbacks] Bad config can't quietly degrade output. We
// either render the user's actual bar (parse OK), the bar plus a warning
// (reload failed but a prior valid config exists), or *only* the warning
// (startup-error: never had a valid config). Either way the failure is
// visible at the point of impact.
const ERROR_ICON_FG = "\x1b[38;2;255;255;255m";
const ERROR_ICON_BG = "\x1b[48;2;200;40;40m";
const ANSI_RESET = "\x1b[0m";
const OSC8_OPEN = "\x1b]8;;";
const OSC8_CLOSE = "\x1b]8;;\x1b\\";
const ST = "\x1b\\";

function composeWithError(body: string, error: string | null): string {
  if (!error) return body;
  const url = `cc-candybar://show-config-error/${encodeURIComponent(error)}`;
  const link = `${OSC8_OPEN}${url}${ST}${ERROR_ICON_BG}${ERROR_ICON_FG} ⚠ config error ${ANSI_RESET}${OSC8_CLOSE}`;
  // No body → emit the icon alone (startup-error case). Body present →
  // prepend on its own line so it's visible regardless of bar width.
  return body ? `${link}\n${body}` : link;
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

// [LAW:single-enforcer] The payload-builder dependency bundle. One value
// passed through every render — the data the daemon brings to each tick.
const payloadDeps = {
  gitProvider: gitService,
  usageProvider,
  todayProvider,
  contextProvider,
  metricsProvider,
  blockProvider,
  tmuxService,
  sessionState,
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
