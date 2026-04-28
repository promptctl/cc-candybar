import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { daemonDir, pidPath, socketPath } from "./paths";
import { dlog, closeLog } from "./log";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
} from "./protocol";
import type { Request, Response } from "./protocol";
import { PowerlineRenderer } from "../powerline";
import { loadConfigFromCLI } from "../config/loader";
import { CachedGitService } from "./cache/git";

// [LAW:one-source-of-truth] one cache instance per daemon process — multiple
// instances would defeat the share-across-sessions invariant.
const gitService = new CachedGitService();

const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 200;
const BIN_CHECK_INTERVAL_MS = 60 * 1000;

// Daemon entry point. Acquires a single-instance mutex, listens on the Unix
// socket, dispatches one request per connection, and shuts itself down when
// idle. Any uncaught error in the process exits non-zero — the next client
// will respawn a clean instance via spawnDaemonDetached().
export function runDaemon(): void {
  fs.mkdirSync(daemonDir(), { recursive: true });

  if (!acquirePidfile()) {
    // Another daemon is already running; nothing to do.
    process.exit(0);
  }

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

  // Stale socket file from a crashed prior daemon. Safe to unlink because we
  // hold the pidfile mutex; no live daemon can be bound to this path.
  try {
    fs.unlinkSync(socketPath());
  } catch {}

  const server = net.createServer({ allowHalfOpen: false }, (sock) => {
    handleConnection(sock);
  });

  server.on("error", (err) => {
    dlog("error", `server error: ${err.message}`);
    shutdown(1);
  });

  server.listen(socketPath(), () => {
    try {
      fs.chmodSync(socketPath(), 0o600);
    } catch (e) {
      dlog("warn", `chmod socket failed: ${(e as Error).message}`);
    }
    dlog(
      "info",
      `daemon up: pid=${process.pid} v=${PROTOCOL_VERSION} sock=${socketPath()}`,
    );
    armIdleTimer();
    armBinaryWatch();
  });
}

// --- binary-mtime self-restart ---
//
// If the daemon's source binary changes on disk (rebuild, upgrade, edit), exit
// at the next sample so the next client respawns from the fresh code. Cheap
// (one statSync/min) and avoids the user having to manually kill the daemon
// during development. unref() so this timer doesn't hold the process alive.
function armBinaryWatch(): void {
  const target = process.argv[1];
  if (!target) return;
  let originalMtime: number;
  try {
    originalMtime = fs.statSync(target).mtimeMs;
  } catch {
    return;
  }
  const timer = setInterval(() => {
    try {
      const nowMtime = fs.statSync(target).mtimeMs;
      if (nowMtime !== originalMtime) {
        dlog("info", `binary mtime changed (${target}); shutting down`);
        clearInterval(timer);
        shutdown(0);
      }
    } catch (e) {
      dlog("warn", `bin stat failed: ${(e as Error).message}`);
    }
  }, BIN_CHECK_INTERVAL_MS);
  timer.unref();
}

// --- single-instance mutex ---

let pidfileHeld = false;

function acquirePidfile(): boolean {
  const target = pidPath();
  // Try once; on EEXIST, decide whether the holder is alive.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(target, "wx");
      const payload = JSON.stringify({
        pid: process.pid,
        version: PROTOCOL_VERSION,
        binPath: process.argv[1],
        startedAt: new Date().toISOString(),
      });
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      pidfileHeld = true;
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    // Pidfile exists. Read it, check if owner is alive.
    let holderPid: number | null = null;
    try {
      const raw = fs.readFileSync(target, "utf8");
      holderPid = JSON.parse(raw).pid ?? null;
    } catch {
      holderPid = null;
    }

    if (holderPid && isAlive(holderPid)) {
      dlog(
        "info",
        `another daemon already running (pid=${holderPid}); exiting`,
      );
      return false;
    }

    // Stale. Unlink and retry once.
    dlog(
      "warn",
      `stale pidfile (holder pid=${holderPid ?? "?"} not alive); unlinking`,
    );
    try {
      fs.unlinkSync(target);
    } catch {}
  }
  // Two failed attempts — give up rather than loop.
  dlog("error", "failed to acquire pidfile after retry");
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but owned by another user (rare
    // in single-user mode, but treat as alive to be safe).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releasePidfile(): void {
  if (!pidfileHeld) return;
  try {
    fs.unlinkSync(pidPath());
  } catch {}
  pidfileHeld = false;
}

// --- idle shutdown ---

let idleTimer: NodeJS.Timeout | null = null;
let inFlight = 0;

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (inFlight === 0) {
      dlog("info", `idle ${IDLE_SHUTDOWN_MS}ms — shutting down`);
      shutdown(0);
    } else {
      armIdleTimer();
    }
  }, IDLE_SHUTDOWN_MS);
}

// --- shutdown ---

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  try {
    fs.unlinkSync(socketPath());
  } catch {}
  releasePidfile();
  closeLog();
  // Give any in-flight `sock.write` a moment to flush before exit. 100ms is
  // generous; we'd rather a clean exit than a clipped log line.
  setTimeout(() => process.exit(code), 100);
}

// --- per-connection handler ---

function handleConnection(sock: net.Socket): void {
  inFlight++;
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
    armIdleTimer();
  });
}

async function handleRequest(req: Request): Promise<Response> {
  if (!req || typeof req !== "object" || typeof (req as Request).v !== "number") {
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

  if (req.kind === "render") {
    const t0 = Date.now();
    const projectDir = req.hookData.workspace?.project_dir;
    const config = loadConfigFromCLI(req.args, projectDir);
    const renderer = new PowerlineRenderer(config, { gitService });
    const output = await renderer.generateStatusline(req.hookData);
    const ms = Date.now() - t0;
    const stats = gitService.getStats();
    dlog(
      "info",
      `render sid=${req.hookData.session_id ?? "?"} took=${ms}ms gitCache size=${stats.size} hits=${stats.hits} misses=${stats.misses}`,
    );
    return { ok: true, output: output + "\n" };
  }

  return { ok: false, error: "unknown kind", code: "BAD_REQUEST" };
}

// Suppress "unused path import" — kept for clarity if we add directory ops.
void path;
