import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import process from "node:process";
import { socketPath, spawnLockPath, daemonDir } from "./paths";

// [LAW:single-enforcer] One primitive per runtime that owns the entire
// "obtain a daemon" verb. Three previously-independent spawn sites
// (src/index.ts:171, src/install/index.ts:303, rust-client's spawn fallback)
// all collapse onto this one path. The Rust client mirrors this in the
// `obtain-daemon primitive` section of rust-client/src/main.rs. Both
// runtimes agree on socketPath() and spawnLockPath() *and* on the lock
// mechanism: open(path, O_CREAT | O_EXCL) — existence == held; release by
// unlinking. A Rust kick and a Node kick are mutually recognizable.
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
  // After this much continuous contention on spawn.lock without a daemon
  // appearing, give up on the lock and spawn anyway. The bind() inside the
  // daemon arbitrates duplicates, so a stuck lock degrades to bind-arbitrated
  // contention instead of a multi-second availability gap. Default
  // totalTimeoutMs / 2.
  lockFallbackMs?: number;
  // Test hook: replace the actual spawn call. Returning false simulates
  // "spawn failed"; default spawns the real daemon.
  spawn?: () => boolean;
}

const DEFAULT_OPTS: Required<Omit<ObtainOpts, "spawn" | "lockFallbackMs">> = {
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
  const lockFallbackMs =
    opts.lockFallbackMs ?? Math.floor(settings.totalTimeoutMs / 2);

  // [LAW:no-defensive-null-guards] obtainDaemon is typed Promise<ObtainResult>
  // — synchronous filesystem failures (read-only FS, permission denial) must
  // become typed failure outcomes, not throws that surprise the caller.
  const setupErr = ensureStateDir();
  if (setupErr) return { kind: "failed", reason: setupErr };

  // Fast path: is a daemon already listening?
  if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
    return { kind: "attached" };
  }

  // No daemon yet. Try to win the spawn-lock so we are the one to bring it up.
  const contentionStart = Date.now();
  while (Date.now() < deadline) {
    const lock = tryAcquireSpawnLock();
    if (lock.kind === "error") {
      // [LAW:no-silent-fallbacks] Unrecoverable errors (EACCES, ENOTDIR,
      // broken state dir) must not silently degrade into a contention loop
      // + timeout. The caller gets an actionable reason.
      return { kind: "failed", reason: `spawn-lock: ${lock.reason}` };
    }
    if (lock.kind === "held") {
      try {
        // Re-check: another caller may have spawned a daemon between our
        // initial connect and our lock acquisition.
        if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
          return { kind: "attached" };
        }
        return await spawnAndWaitForReady(
          spawnFn,
          settings.spawnReadyTimeoutMs,
          settings.connectTimeoutMs,
          deadline,
          "",
        );
      } finally {
        releaseSpawnLock();
      }
    }
    // Lock contended. Another caller is in the spawn window — brief wait,
    // then re-check for the socket they're bringing up.
    await sleep(20);
    if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
      return { kind: "attached" };
    }
    // [LAW:dataflow-not-control-flow] spawn.lock is an optimization; bind()
    // is the load-bearing exclusion. If we've been contended past the
    // fallback threshold (e.g. crashed lock holder, slow staleness reclaim),
    // bypass the lock and let bind() inside the daemon arbitrate duplicates.
    // Same shape as a fresh spawn — caller pays one extra Node startup cost
    // in the worst case, which is the right trade for availability.
    if (Date.now() - contentionStart > lockFallbackMs) {
      return await spawnAndWaitForReady(
        spawnFn,
        settings.spawnReadyTimeoutMs,
        settings.connectTimeoutMs,
        deadline,
        " (lock-fallback)",
      );
    }
  }

  return { kind: "failed", reason: "timeout obtaining daemon" };
}

// Spawn the daemon, then poll for it to bind. Returns the typed outcome.
// Shared by the lock-held path and the lock-fallback path so they don't drift.
async function spawnAndWaitForReady(
  spawnFn: () => boolean,
  spawnReadyTimeoutMs: number,
  connectTimeoutMs: number,
  outerDeadline: number,
  reasonSuffix: string,
): Promise<ObtainResult> {
  // [LAW:no-defensive-null-guards] obtainDaemon is typed Promise<ObtainResult>.
  // A synchronous throw from child_process.spawn (ENOENT, invalid options)
  // must become a typed failure, not a rejected promise.
  let didSpawn = false;
  try {
    didSpawn = spawnFn();
  } catch (e) {
    return {
      kind: "failed",
      reason: `spawn threw${reasonSuffix}: ${(e as Error).message}`,
    };
  }
  if (!didSpawn) {
    return {
      kind: "failed",
      reason: `spawn returned false${reasonSuffix}`,
    };
  }
  const readyDeadline = Math.min(
    Date.now() + spawnReadyTimeoutMs,
    outerDeadline,
  );
  while (Date.now() < readyDeadline) {
    if (await canConnect(socketPath(), connectTimeoutMs)) {
      return { kind: "started" };
    }
    await sleep(20);
  }
  return {
    kind: "failed",
    reason: `daemon did not bind in time${reasonSuffix}`,
  };
}

// Synchronous fire-and-forget kick — used for "daemon-miss" recovery where
// the current render is already lost and we just want to warm the daemon for
// the next refresh. Mirrors the Rust client's obtain_daemon_kick at the same
// shape: lock + spawn + release, all synchronous, no await.
//
// [LAW:one-type-per-behavior] This is the Node mirror of Rust's
// obtain_daemon_kick in rust-client/src/main.rs. Both runtimes use the same
// existence-as-lock semantics so a Rust kick and a Node kick are mutually
// recognizable. The bind() inside the daemon arbitrates any duplicate spawns
// that slip past the lock.
//
// Why synchronous: callers (src/index.ts, src/install/index.ts) call this
// immediately before process.exit(). An async variant would suspend on the
// first await and never resume — process.exit would kill the process before
// child_process.spawn ever runs. The lock+spawn must complete in synchronous
// turn for the daemon to actually start.
export function obtainDaemonKick(opts: { spawn?: () => boolean } = {}): void {
  if (ensureStateDir() !== null) return;
  const spawnFn = opts.spawn ?? spawnDaemonDetachedReal;
  const lock = tryAcquireSpawnLock();
  if (lock.kind !== "held") return; // contention or error — give up silently
  try {
    // [LAW:no-defensive-null-guards] Kick path is fire-and-forget; a spawn
    // failure here is best-effort. Swallowing prevents an uncaught throw from
    // crashing the calling process at the wrong moment (right before its own
    // exit). It is logged via stderr for visibility.
    try {
      spawnFn();
    } catch (e) {
      process.stderr.write(
        `cc-candybar: daemon spawn failed: ${(e as Error).message}\n`,
      );
    }
  } finally {
    releaseSpawnLock();
  }
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

type LockOutcome =
  | { kind: "held" }
  | { kind: "contended" }
  | { kind: "error"; reason: string };

function tryAcquireSpawnLock(): LockOutcome {
  const path = spawnLockPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(path, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } catch {}
      heldLock = { fd, path };
      return { kind: "held" };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // EACCES, ENOTDIR, ENOSPC, etc. are not contention — they are
        // unrecoverable. Surface upward instead of pretending we lost a race.
        return {
          kind: "error",
          reason: `openSync(${path}): ${code ?? (e as Error).message}`,
        };
      }
    }
    if (!isLockStale(path)) return { kind: "contended" };
    try {
      fs.unlinkSync(path);
    } catch (e) {
      // Stale lock present but we can't remove it — same class of fatal as
      // openSync failure. Don't spin pretending it's contention.
      return {
        kind: "error",
        reason: `unlink stale spawn.lock: ${(e as Error).message}`,
      };
    }
  }
  return { kind: "contended" };
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

// ─── State-dir setup ────────────────────────────────────────────────────────

// Returns null on success, or a reason string on unrecoverable failure. Used
// by both obtainDaemon (which converts to a `failed` result) and
// obtainDaemonKick (which silently gives up — there is no caller to report to).
function ensureStateDir(): string | null {
  try {
    fs.mkdirSync(daemonDir(), { recursive: true });
    return null;
  } catch (e) {
    return `mkdir ${daemonDir()}: ${(e as Error).message}`;
  }
}

// ─── Connect probe ──────────────────────────────────────────────────────────

function canConnect(sockPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      resolve(result);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

// ─── Default spawn implementation ───────────────────────────────────────────
//
// Cap V8 old-generation at 400 MB so GC fires before RSS hits the 512 MB hard
// limit. The Rust client mirrors this in rust-client/src/main.rs
// (spawn_daemon_detached) — keep the two in sync when changing this value.
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
