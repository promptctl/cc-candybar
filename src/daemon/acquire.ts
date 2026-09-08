import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { launchDetachedSync } from "../proc/launch";
import { heapCapMb } from "./limits";
import process from "node:process";
import {
  socketPath,
  spawnLockPath,
  spawnCooldownPath,
  spawnBackoffPath,
  daemonDir,
} from "./paths";

// [LAW:single-enforcer] One primitive per runtime owns "obtain a daemon", locking
// with open(path, "wx") so a Rust kick and a Node kick recognize each other.
// [LAW:dataflow-not-control-flow] Callers get a typed outcome, not a choice.

export type ObtainResult =
  | { kind: "attached" }
  | { kind: "started" }
  | { kind: "failed"; reason: string };

interface ObtainOpts {
  totalTimeoutMs?: number;
  // AF_UNIX connect to a live listener is sub-ms; slower implies no listener.
  connectTimeoutMs?: number;
  spawnReadyTimeoutMs?: number;
  // Past this much lock contention, spawn anyway and let bind() arbitrate.
  lockFallbackMs?: number;
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

  // [LAW:no-defensive-null-guards] Filesystem failures become typed outcomes.
  const setupErr = ensureStateDir();
  if (setupErr) return { kind: "failed", reason: setupErr };

  if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
    return { kind: "attached" };
  }

  const contentionStart = Date.now();
  while (Date.now() < deadline) {
    const lock = tryAcquireSpawnLock();
    if (lock.kind === "error") {
      // [LAW:no-silent-fallbacks] EACCES/ENOTDIR are not contention; say so.
      return { kind: "failed", reason: `spawn-lock: ${lock.reason}` };
    }
    if (lock.kind === "held") {
      try {
        // Another caller may have spawned between our connect and this lock.
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
    await sleep(20);
    if (await canConnect(socketPath(), settings.connectTimeoutMs)) {
      return { kind: "attached" };
    }
    // [LAW:dataflow-not-control-flow] spawn.lock optimizes; bind() excludes.
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

async function spawnAndWaitForReady(
  spawnFn: () => boolean,
  spawnReadyTimeoutMs: number,
  connectTimeoutMs: number,
  outerDeadline: number,
  reasonSuffix: string,
): Promise<ObtainResult> {
  const readyDeadline = Math.min(
    Date.now() + spawnReadyTimeoutMs,
    outerDeadline,
  );

  // [LAW:one-source-of-truth] A spawn inside the cooldown is already in flight.
  if (!claimSpawnCooldown()) {
    // [LAW:no-silent-failure] Cooldown, not the lock path — no reasonSuffix.
    return (await pollUntilReady(connectTimeoutMs, readyDeadline))
      ? { kind: "attached" }
      : {
          kind: "failed",
          reason: "spawn on cooldown; no daemon became ready during the wait",
        };
  }

  // [LAW:no-defensive-null-guards] A synchronous spawn throw becomes a failure.
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
  return (await pollUntilReady(connectTimeoutMs, readyDeadline))
    ? { kind: "started" }
    : {
        kind: "failed",
        reason: `daemon did not bind in time${reasonSuffix}`,
      };
}

async function pollUntilReady(
  connectTimeoutMs: number,
  readyDeadline: number,
): Promise<boolean> {
  while (Date.now() < readyDeadline) {
    if (await canConnect(socketPath(), connectTimeoutMs)) return true;
    await sleep(20);
  }
  return false;
}

// Synchronous is load-bearing: callers exit immediately after, so an await would
// suspend past process.exit and the spawn would never run. Past this hold age the
// kick assumes a crashed holder and spawns unlocked.
const KICK_CONTENDED_OVERRIDE_MS = 2_000;

export function obtainDaemonKick(opts: { spawn?: () => boolean } = {}): void {
  if (ensureStateDir() !== null) return;
  const spawnFn = opts.spawn ?? spawnDaemonDetachedReal;
  const lock = tryAcquireSpawnLock();

  // [LAW:dataflow-not-control-flow] A long-held lock or a lock error both spawn unlocked.
  if (lock.kind === "contended") {
    const ageMs = spawnLockAgeMs();
    if (ageMs !== null && ageMs > KICK_CONTENDED_OVERRIDE_MS) {
      process.stderr.write(
        `cc-candybar: spawn-lock held ${ageMs}ms (likely crashed holder) — spawning unlocked\n`,
      );
      cooldownGatedSpawn(spawnFn);
    }
    return;
  }
  if (lock.kind === "error") {
    process.stderr.write(
      `cc-candybar: spawn-lock unavailable (${lock.reason}) — spawning unlocked\n`,
    );
    cooldownGatedSpawn(spawnFn);
    return;
  }
  try {
    cooldownGatedSpawn(spawnFn);
  } finally {
    releaseSpawnLock();
  }
}

// [LAW:single-enforcer] Every kick spawn site routes through here, one rate bound.
function cooldownGatedSpawn(spawnFn: () => boolean): void {
  if (!claimSpawnCooldown()) return;
  safeSpawn(spawnFn);
}

function spawnLockAgeMs(): number | null {
  try {
    const st = fs.statSync(spawnLockPath());
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

// [LAW:no-defensive-null-guards] A throw here would crash the caller mid-exit.
function safeSpawn(spawnFn: () => boolean): void {
  try {
    if (!spawnFn()) {
      process.stderr.write(
        "cc-candybar: daemon spawn returned false (unable to resolve script path?)\n",
      );
    }
  } catch (e) {
    process.stderr.write(
      `cc-candybar: daemon spawn failed: ${(e as Error).message}\n`,
    );
  }
}

// [LAW:one-source-of-truth] spawn.lock dedups at one INSTANT; this bounds spawns
// over TIME. The Rust kick releases the lock milliseconds after forking, well
// before the 0.5-3s Node boot, so without it an outage re-spawns every tick.
export const SPAWN_COOLDOWN_MS = 3_000;

// [LAW:effects-at-boundaries] Pure over the record's age. A future mtime beyond
// the stale window must not pin the cooldown forever; a small negative age is ms
// truncation of a just-recorded attempt.
export type CooldownDecision =
  | { kind: "allow" }
  | { kind: "allow-future-garbage"; futureMs: number }
  | { kind: "deny" };

// [LAW:types-are-the-program] `cooldownMs` is a parameter, so base and backed-off fold alike.
export function cooldownDecision(
  ageMs: number | null,
  cooldownMs: number,
): CooldownDecision {
  if (ageMs === null) return { kind: "allow" };
  if (ageMs < -STALE_LOCK_MS)
    return { kind: "allow-future-garbage", futureMs: -ageMs };
  if (ageMs < cooldownMs) return { kind: "deny" };
  return { kind: "allow" };
}

// [LAW:one-source-of-truth] spawn.cooldown's mtime says WHEN; this streak says how
// many attempts in a row failed to converge — a count mtime cannot carry.
// [LAW:single-enforcer] Only the daemon knows convergence happened, so the reset
// is called from server.ts's onListening(). Capping keeps Rust's `<<` in range.
export const SPAWN_BACKOFF_CAP_MS = 60_000;
export const SPAWN_BACKOFF_MAX_STREAK = 5;

// [LAW:behavior-not-structure] Pure; mirrors Rust's effective_cooldown_ms.
export function effectiveCooldownMs(streak: number): number {
  const capped = Math.min(Math.max(streak, 0), SPAWN_BACKOFF_MAX_STREAK);
  return Math.min(SPAWN_COOLDOWN_MS * 2 ** capped, SPAWN_BACKOFF_CAP_MS);
}

// [LAW:no-defensive-null-guards] Number, not parseInt — trailing garbage ("5abc")
// must fail closed to NaN rather than truncate to a plausible integer.
export function readBackoffStreak(filePath: string): number {
  // [LAW:no-silent-failure] A missing file fails toward the base spawn rate.
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return 0;
    return Math.min(n, SPAWN_BACKOFF_MAX_STREAK);
  } catch {
    return 0;
  }
}

// [LAW:no-ambient-temporal-coupling] Read-then-write is not atomic across
// processes; the only race direction is UNDERcounting, never more spawning.
function writeBackoffStreak(filePath: string, streak: number): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(streak), { mode: 0o600 });
  } catch (e) {
    process.stderr.write(
      `cc-candybar: could not record spawn.backoff: ${(e as Error).message}\n`,
    );
  }
}

// Called by the daemon the moment it binds — the one fact answering "did an outage
// just end." Absence already reads as streak 0, so reset deletes rather than writes.
export function resetSpawnBackoff(): void {
  try {
    fs.unlinkSync(spawnBackoffPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `cc-candybar: could not reset spawn.backoff: ${(e as Error).message}\n`,
      );
    }
  }
}

// [LAW:single-enforcer] Sole authority on daemon-spawn RATE. Recording the attempt
// BEFORE the caller spawns is load-bearing: a broken binary still counts, so it is
// not retried in a tight loop.
function claimSpawnCooldown(): boolean {
  const cooldownPath = spawnCooldownPath();
  const backoffPath = spawnBackoffPath();
  const streak = readBackoffStreak(backoffPath);
  const decision = cooldownDecision(
    cooldownAgeMs(cooldownPath),
    effectiveCooldownMs(streak),
  );
  if (decision.kind === "deny") return false;
  if (decision.kind === "allow-future-garbage") {
    process.stderr.write(
      `cc-candybar: spawn.cooldown mtime is ${decision.futureMs}ms in the future — ignoring and spawning\n`,
    );
  }
  recordSpawnAttempt(cooldownPath);
  // [LAW:dataflow-not-control-flow] Every granted spawn advances the streak.
  writeBackoffStreak(
    backoffPath,
    Math.min(streak + 1, SPAWN_BACKOFF_MAX_STREAK),
  );
  return true;
}

function cooldownAgeMs(path: string): number | null {
  try {
    return Date.now() - fs.statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function recordSpawnAttempt(filePath: string): void {
  // [LAW:composability] Self-sufficient; the mtime is the authority, not the content.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${process.pid} ${Date.now()}\n`, {
      mode: 0o600,
    });
  } catch (e) {
    process.stderr.write(
      `cc-candybar: could not record spawn.cooldown: ${(e as Error).message}\n`,
    );
  }
}

// O_EXLOCK / fcntl(F_SETLK) aren't reliably exposed across Node platforms, so the
// primitive is open(path, "wx") and staleness is time-based. The reclaim is the
// lock's bounded-staleness policy, not a liveness guess; bind() is correctness.

// Mirrored TS↔Rust (diffed by check-protocol).
export const STALE_LOCK_MS = 10_000;

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
        // Not contention — unrecoverable. Never pretend we lost a race.
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
      // ENOENT is the desired post-condition; retry. Other failures are real.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return {
          kind: "error",
          reason: `unlink stale spawn.lock: ${(e as Error).message}`,
        };
      }
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

function ensureStateDir(): string | null {
  try {
    fs.mkdirSync(daemonDir(), { recursive: true });
    return null;
  } catch (e) {
    return `mkdir ${daemonDir()}: ${(e as Error).message}`;
  }
}

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

// [LAW:one-source-of-truth] The V8 old-space cap derives from the daemon's RSS
// budget — it must sit ABOVE the RSS backstop so the graceful path fires first.
// [LAW:single-enforcer] Routes through src/proc/launch so the spawn is metered.
function spawnDaemonDetachedReal(): boolean {
  const node = process.execPath;
  const script = process.argv[1];
  if (!script) return false;
  // [LAW:no-silent-fallbacks] The typed outcome propagates as `false`.
  const result = launchDetachedSync({
    bin: node,
    args: [`--max-old-space-size=${heapCapMb(process.env)}`, script, "daemon"],
    category: "daemon-spawn",
  });
  return result.ok;
}
