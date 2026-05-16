import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { daemonDir, pidPath, socketPath } from "./paths";
import { dlog, closeLog } from "./log";
import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "./protocol";
import type { Request, Response } from "./protocol";
import { GitDataProvider } from "./cache/git";
import { CachedUsageProvider } from "./cache/usage";
import { RenderCache } from "./cache/render";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
import { makeLimits, realLimitsDeps, type LimitsHandle } from "./limits";
import { SessionState } from "./session-state";
import { listAvailableThemes } from "../themes/cascade.js";
import { STYLE_ORDER } from "../themes/default-mapping.js";
import { validateHookData } from "../utils/schema-validator.js";
import { launchSync, setLaunchStats } from "../proc/launch";

// [LAW:one-source-of-truth] one cache instance per daemon process — multiple
// instances would defeat the share-across-sessions invariant.
const stats = new RuntimeStats();
// [LAW:single-enforcer] Route all child_process spawns through src/proc/launch.
// Installing the metering handle here makes subprocess counts visible in
// daemon-stats.
setLaunchStats(stats.launchStats);
const watcherRegistry = new WatcherRegistry({ counters: stats });
const gitService = new GitDataProvider({ watchers: watcherRegistry });
const usageProvider = new CachedUsageProvider();
const sessionState = new SessionState();
const renderCache = new RenderCache({
  gitService,
  usageProvider,
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
  removePidfileDiagnostic();
  closeLog();
  // [LAW:single-enforcer] Exactly one path out of the process. Backstop with
  // SIGKILL because we previously observed shut-down daemons staying alive in
  // uv__io_poll — something (event loop handle, swallowed exception in a
  // post-end log write) was preventing process.exit from actually firing.
  // The hard kill makes "shutdown was called" mechanically equivalent to
  // "process is gone", which is the invariant the singleton mutex relies on.
  const kill = setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
  kill.unref();
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
    respond({ ok: false, error: "request exceeded 200ms", code: "TIMEOUT" });
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
          });
        });
    },
    (err) => {
      dlog("warn", `frame parse failed: ${err.message}`);
      respond({ ok: false, error: err.message, code: "BAD_REQUEST" });
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
    return { ok: false, error: "malformed request", code: "BAD_REQUEST" };
  }

  if (req.v !== PROTOCOL_VERSION) {
    // Newer client connected — assume binary upgrade and exit so the next
    // client respawns from the current binary.
    dlog(
      "info",
      `version mismatch: client=${req.v} daemon=${PROTOCOL_VERSION}; shutting down`,
    );
    setTimeout(() => shutdown(0), 50);
    return {
      ok: false,
      error: `protocol v${req.v} not supported (daemon at v${PROTOCOL_VERSION})`,
      code: "VERSION_MISMATCH",
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
      // [LAW:dataflow-not-control-flow] Three states fall out of one rule:
      // body = renderer ? render(it) : "" ; output = body + (error ? icon : "")
      // No special-case branches — same composition every render.
      const body = entry.renderer
        ? await entry.renderer.generateStatusline(req.hookData)
        : "";
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

  return { ok: false, error: "unknown kind", code: "BAD_REQUEST" };
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
// [LAW:dataflow-not-control-flow] Verb dispatch table — each entry maps a verb
// to a handler. Adding a verb means adding a row, not branching deeper.
const clickHandlers: Record<string, (value: string) => void> = {
  copy: clickCopy,
  "open-vscode": clickOpenVscode,
  "toolbar-toggle": clickToolbarToggle,
  "theme-cycle": clickThemeCycle,
  "style-cycle": clickStyleCycle,
  "show-config-error": clickShowConfigError,
};

function handleClick(verb: string, value: string): Response {
  const handler = clickHandlers[verb];
  if (!handler) {
    return {
      ok: false,
      error: `unknown click verb: ${verb}`,
      code: "BAD_REQUEST",
    };
  }
  try {
    handler(value);
    return { ok: true, output: "" };
  } catch (e) {
    return {
      ok: false,
      error: String(e instanceof Error ? e.message : e),
      code: "RENDER_FAILED",
    };
  }
}

function clickCopy(text: string): void {
  const result = launchSync({
    bin: "/usr/bin/pbcopy",
    stdinInput: text,
    category: "click.pbcopy",
  });
  if (!result.ok) {
    throw new Error(
      `pbcopy failed (${result.reason}, exit ${result.exitCode ?? "null"})`,
    );
  }
}

// Click on the ⚠ in the bar copies the parse error to clipboard. Behavior
// can grow later (e.g. open the offending file at the parse-error line).
function clickShowConfigError(encodedMessage: string): void {
  clickCopy(encodedMessage);
}

function clickOpenVscode(target: string): void {
  const result = launchSync({
    bin: "/usr/bin/open",
    args: ["-a", "Visual Studio Code", target],
    category: "click.open",
  });
  if (!result.ok) {
    throw new Error(
      `open -a "Visual Studio Code" failed (${result.reason}, exit ${result.exitCode ?? "null"})`,
    );
  }
}

function clickToolbarToggle(sessionId: string): void {
  if (!sessionId) return;
  if (sessionId.includes("/") || sessionId.includes("..")) return;
  // [LAW:one-source-of-truth] In-memory SessionState is authoritative. File is
  // persistence for cold start (non-daemon renders read it directly).
  const expanded = sessionState.get(sessionId, "toolbar-expanded");
  if (expanded) sessionState.clear(sessionId, "toolbar-expanded");
  else sessionState.set(sessionId, "toolbar-expanded", "1");
  const dir = path.join(os.homedir(), ".claude", ".toolbar-state");
  const flagPath = path.join(dir, sessionId);
  try {
    if (fs.existsSync(flagPath)) {
      fs.unlinkSync(flagPath);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(flagPath, "");
    }
  } catch (e) {
    dlog("warn", `toolbar-toggle file write failed: ${(e as Error).message}`);
  }
}

// [LAW:dataflow-not-control-flow] Theme/style state is per-session. The value
// parameter is the session ID (passed via cpwl://theme-cycle/<sessionId>). No
// clearAll() needed — the renderer reads state dynamically per render.
function clickThemeCycle(sessionId: string): void {
  const themes = listAvailableThemes().filter((t) => t !== "custom");
  const current = sessionState.get(sessionId, "theme");
  const idx = current ? themes.indexOf(current) : -1;
  const next = themes[(idx + 1) % themes.length] ?? themes[0]!;
  sessionState.set(sessionId, "theme", next);
  dlog(
    "info",
    `theme-cycle: ${current ?? "(default)"} → ${next} (session=${sessionId})`,
  );
}

function clickStyleCycle(sessionId: string): void {
  const current = sessionState.get(sessionId, "style");
  const idx = current ? STYLE_ORDER.indexOf(current) : -1;
  const next = STYLE_ORDER[(idx + 1) % STYLE_ORDER.length] ?? STYLE_ORDER[0]!;
  sessionState.set(sessionId, "style", next);
  dlog(
    "info",
    `style-cycle: ${current ?? "(default)"} → ${next} (session=${sessionId})`,
  );
}

// Suppress "unused path import" — kept for clarity if we add directory ops.
void path;
