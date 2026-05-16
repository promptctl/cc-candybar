import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import process from "node:process";
import { socketPath, spawnLockPath, daemonDir } from "./paths";

// [LAW:single-enforcer] One primitive per runtime that owns the entire
// "obtain a daemon" verb. Three previously-independent spawn sites
// (src/index.ts:171, src/install/index.ts:303, rust-client's spawn fallback)
// all collapse onto this one path. The Rust client has its own mirror at
// rust-client/src/acquire.rs that uses real flock for the spawn dedup; both
// runtimes agree on socketPath() and spawnLockPath().
//
// [LAW:dataflow-not-control-flow] Callers do not get to choose whether to
// spawn. They request a daemon; this function returns one of three typed
// outcomes. The decision lives in the data (connect result, lock acquisition,
// re-check after lock).

export type ObtainResult =
  | { kind: "attached" }
  | { kind: "started" }
  | { kind: "failed"; reason: string };

interface ObtainOpts {
  // Total deadline for the entire obtain operation. After this elapses we
  // return { kind: "failed" } even if a daemon could come up shortly. Default
  // 2000ms — generous for cold start, tight enough to bound user-visible
  // latency on a busted state directory.
  totalTimeoutMs?: number;
  // Per-connect probe timeout. AF_UNIX connect to a live listener is sub-ms;
  // anything slower implies "no listener" in practice.
  connectTimeoutMs?: number;
  // How long to wait after spawning before giving up on the daemon coming up.
  spawnReadyTimeoutMs?: number;
  // Test hook: replace the actual spawn call. Returning false simulates
  // "spawn failed"; default spawns the real daemon.
  spawn?: () => boolean;
}

const DEFAULT_OPTS: Required<Omit<ObtainOpts, "spawn">> = {
  totalTimeoutMs: 2000,
  connectTimeoutMs: 50,
  spawnReadyTimeoutMs: 1500,
};

export async function obtainDaemon(
  opts: ObtainOpts = {},
): Promise<ObtainResult> {
  const settings = { ...DEFAULT_OPTS, ...opts };
  const spawnFn = opts.spawn ?? spawnDaemonDetachedReal;
  const deadline = Date.now() + settings.totalTimeoutMs;

  fs.mkdirSync(daemonDir(), { recursive: true });

  // Fast path: is a daemon already listening?
  if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
    return { kind: "attached" };
  }

  // No daemon yet. Try to win the spawn-lock so we are the one to bring it up.
  while (Date.now() < deadline) {
    const lock = tryAcquireSpawnLock();
    if (lock === "held") {
      try {
        // Re-check: another caller may have spawned a daemon between our
        // initial connect and our lock acquisition.
        if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
          return { kind: "attached" };
        }
        if (!spawnFn()) {
          return { kind: "failed", reason: "spawn returned false" };
        }
        // Poll for the new daemon to bind.
        const readyDeadline = Math.min(
          Date.now() + settings.spawnReadyTimeoutMs,
          deadline,
        );
        while (Date.now() < readyDeadline) {
          if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
            return { kind: "started" };
          }
          await sleep(20);
        }
        return { kind: "failed", reason: "daemon did not bind in time" };
      } finally {
        releaseSpawnLock();
      }
    }
    // Another caller is in the spawn window. Brief wait, then re-check for
    // the socket they're bringing up — no need to take the lock ourselves.
    await sleep(20);
    if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
      return { kind: "attached" };
    }
  }

  return { kind: "failed", reason: "timeout obtaining daemon" };
}

// Fire-and-forget version. Caller doesn't care about the outcome — used for
// "daemon-miss" recovery where the current render is already lost and we just
// want to warm the daemon for the next refresh. Mirrors the previous
// spawnDaemonDetached() callers in src/index.ts and src/install/index.ts.
//
// [LAW:dataflow-not-control-flow] This is still the same operation as
// obtainDaemon — just with the result discarded. Callers do not skip the
// dedup logic; they just don't wait.
export function obtainDaemonAsync(opts: ObtainOpts = {}): void {
  void obtainDaemon(opts).catch(() => {
    // Any failure is best-effort; the next refresh will retry.
  });
}

// ─── Spawn-lock (Node side) ──────────────────────────────────────────────────
//
// O_EXLOCK / fcntl(F_SETLK) aren't reliably exposed across Node platforms, so
// we use the simplest portable atomic primitive: open(path, "wx"). The file
// records owner pid + timestamp. Staleness is time-based — if the file is
// older than STALE_LOCK_MS we forcibly claim it. The spawn window is
// sub-second in practice; 10s is a wide tolerance.
//
// [LAW:no-defensive-null-guards] The staleness reclaim is not a "the holder
// might be dead, let me check" guard — it is the bounded-staleness policy of
// the lock. The bind() in the daemon is the real correctness boundary; this
// lock is a thundering-herd optimization, so a missed dedup just means one
// extra Node process eats a bind() race and exits.

const STALE_LOCK_MS = 10_000;

let heldLock: { fd: number; path: string } | null = null;

function tryAcquireSpawnLock(): "held" | "contended" {
  const path = spawnLockPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(path, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } catch {}
      heldLock = { fd, path };
      return "held";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return "contended";
    }
    if (!isLockStale(path)) return "contended";
    try {
      fs.unlinkSync(path);
    } catch {}
  }
  return "contended";
}

function isLockStale(path: string): boolean {
  try {
    const st = fs.statSync(path);
    return Date.now() - st.mtimeMs > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

function releaseSpawnLock(): void {
  if (!heldLock) return;
  const { fd, path } = heldLock;
  heldLock = null;
  try {
    fs.closeSync(fd);
  } catch {}
  try {
    fs.unlinkSync(path);
  } catch {}
}

// ─── Connect probe ──────────────────────────────────────────────────────────

function canConnect(sockPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    let settled = false;
    const done = (result: boolean): void => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(result);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs).unref();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

// ─── Default spawn implementation ───────────────────────────────────────────
//
// Cap V8 old-generation at 400 MB so GC fires before RSS hits the 512 MB hard
// limit. The Rust client mirrors this in rust-client/src/acquire.rs — keep
// the two in sync when changing this value.
function spawnDaemonDetachedReal(): boolean {
  const node = process.execPath;
  const script = process.argv[1];
  if (!script) return false;
  const child = spawn(node, ["--max-old-space-size=400", script, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return true;
}
