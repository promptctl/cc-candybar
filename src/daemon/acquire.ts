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

// [LAW:single-enforcer] One primitive per runtime that owns the entire
// "obtain a daemon" verb. Every spawn site in the Node runtime now flows
// through this one path; the Rust client mirrors it in its own
// obtain-daemon primitive. Both runtimes agree on socketPath() and
// spawnLockPath() *and* on the lock mechanism: open(path, O_CREAT | O_EXCL)
// — existence == held; release by unlinking. A Rust kick and a Node kick
// are mutually recognizable.
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
  const readyDeadline = Math.min(
    Date.now() + spawnReadyTimeoutMs,
    outerDeadline,
  );

  // [LAW:dataflow-not-control-flow] The spawn-rate bound is consulted as data,
  // not a mode. If a spawn was attempted within SPAWN_COOLDOWN_MS, one is
  // already in flight — do NOT add another Node process; wait for the in-flight
  // boot. This keeps obtainDaemon under the same global rate cap as the kick
  // path, so the rate bound holds for EVERY spawn site [LAW:one-source-of-truth].
  if (!claimSpawnCooldown()) {
    // [LAW:no-silent-failure] This failure's cause is the cooldown gate, not the
    // lock path we arrived through — so it does NOT inherit reasonSuffix (which
    // tags lock-held vs lock-fallback *spawn* provenance). We never spawned here.
    return (await pollUntilReady(connectTimeoutMs, readyDeadline))
      ? { kind: "attached" }
      : {
          kind: "failed",
          reason: "spawn on cooldown; no daemon became ready during the wait",
        };
  }

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
  return (await pollUntilReady(connectTimeoutMs, readyDeadline))
    ? { kind: "started" }
    : {
        kind: "failed",
        reason: `daemon did not bind in time${reasonSuffix}`,
      };
}

// Poll the socket until a daemon answers or the deadline elapses. Shared by the
// spawn path (→ "started") and the cooldown-blocked wait path (→ "attached"):
// both need "did a daemon come up in time", they differ only in how they label
// the outcome.
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
// If the spawn.lock has existed longer than this, the kick path assumes the
// holder crashed mid-spawn and overrides to preserve availability.
// Calibrated to be much larger than any legitimate hold:
//   - A healthy kick holds for <10ms (fork + release).
//   - obtainDaemon's lock-held path can hold up to spawnReadyTimeoutMs
//     (1500ms default) while polling for the new daemon to bind.
// 2s leaves a comfortable margin above the slowest legitimate holder while
// still recovering from a crashed-mid-spawn holder well before STALE_LOCK_MS.
const KICK_CONTENDED_OVERRIDE_MS = 2_000;

export function obtainDaemonKick(opts: { spawn?: () => boolean } = {}): void {
  if (ensureStateDir() !== null) return;
  const spawnFn = opts.spawn ?? spawnDaemonDetachedReal;
  const lock = tryAcquireSpawnLock();

  // [LAW:dataflow-not-control-flow] Lock outcome is data, not control flow.
  // - "contended": typically means another caller is in the spawn window;
  //   trust them and return. BUT: if the lock has been held suspiciously
  //   long, the holder is likely crashed mid-spawn — override and spawn
  //   unlocked. bind() arbitrates any duplicates.
  // - "error": spawn-lock unavailable (broken state dir, perms). Per the
  //   architecture, spawn.lock is an *optimization* on top of bind()'s
  //   load-bearing exclusion — a lock error should NOT make this kick a
  //   hard stop on availability. Fall through to an unlocked spawn.
  // - "held": normal path — spawn under the lock.
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

// [LAW:single-enforcer] Every kick spawn site routes through here, so the
// spawn-rate bound is applied at exactly one boundary — mirror of Rust's
// spawn_daemon_rate_limited. On cooldown we do nothing: a spawn was attempted
// within SPAWN_COOLDOWN_MS and is likely still booting; the kick is
// fire-and-forget, so "already in flight" is a complete answer.
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

// [LAW:no-defensive-null-guards] Kick path is fire-and-forget; a spawn
// failure here is best-effort. Swallowing prevents an uncaught throw from
// crashing the calling process at the wrong moment (right before its own
// exit). Both failure modes (throw and false-return) are logged via stderr
// so kick failures stay visible — silent failure is the worst outcome.
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

// ─── Spawn cooldown (shared spawn-RATE bound) ────────────────────────────────
//
// [LAW:one-source-of-truth] spawn.lock dedups spawns at one INSTANT; the
// cooldown bounds them over TIME. Without it, the Rust kick — which releases
// spawn.lock milliseconds after forking, before the 0.5-3s Node boot window —
// re-spawns on every render tick during an outage (spawn rate ≈ tick rate:
// dozens/sec, process-table exhaustion). One file's mtime records the last spawn
// ATTEMPT; both runtimes consult it. The constant and filename are mirrored TS↔
// Rust (scripts/check-protocol.mjs). Worst case with the bound: ~20 spawns/min
// globally, each of which exits cleanly via the sibling socket-lease defenses.
// Exported for the boundary unit tests (test/daemon-acquire.test.ts), which pin
// the window arithmetic against the exact constant the same way the Rust unit
// tests do — so a TS↔Rust decision divergence at a boundary is caught even
// though check-protocol only diffs the constant's value.
export const SPAWN_COOLDOWN_MS = 3_000;

// [LAW:effects-at-boundaries] The window arithmetic — the subtle part: a
// future-mtime garbage record (beyond the stale-lock window) must not pin the
// cooldown forever, while a small negative age is just ms-truncation of
// Date.now() against the higher-precision fs mtime and still counts as a
// just-recorded attempt — is a pure function of the record's age, extracted from
// the fs read so it is unit-tested without touching the filesystem. Mirrors the
// Rust cooldown_decision. `null` age (missing/unreadable file) allows (first
// spawn); the mtime IS the timestamp, so "unparseable timestamp" is
// unrepresentable by construction.
export type CooldownDecision =
  | { kind: "allow" }
  | { kind: "allow-future-garbage"; futureMs: number }
  | { kind: "deny" };

// [LAW:types-are-the-program] `cooldownMs` is the required window, not a
// captured constant — the decision is the same pure fold whether the caller
// is checking against the base SPAWN_COOLDOWN_MS or a backed-off window from
// effectiveCooldownMs(streak) below. Generalizing the threshold into a
// parameter is what let brandon-daemon-lifecycle-gad.3 add exponential
// backoff without touching this function's tested boundary arithmetic.
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

// ─── Spawn backoff (consecutive non-convergence widens the cooldown) ────────
//
// [LAW:one-source-of-truth] spawn.cooldown's mtime answers "when was a spawn
// last attempted"; this streak answers "how many attempts in a row have
// failed to converge on a live daemon" — a fact spawn.cooldown's mtime alone
// cannot carry (mtime is overwritten on every attempt, losing the count). One
// small file, one fact, read/written by both runtimes exactly like
// spawn.cooldown itself.
//
// [LAW:single-enforcer] The daemon is the only process that can know
// "convergence achieved" (it just bound the socket and is about to serve) —
// see resetSpawnBackoff(), called once from server.ts's onListening(). A
// client-side reset would need a full successful render round-trip on the
// hot path to detect convergence, adding fs I/O to the common case for a
// signal the daemon already has for free at boot.
//
// Growth is capped at SPAWN_BACKOFF_MAX_STREAK shifts so effectiveCooldownMs
// never has to reason about an unbounded streak (a multi-day outage would
// otherwise grow the stored integer without bound) and so Rust's mirrored
// `<<` cannot overflow. 3_000ms << 5 = 96_000ms, already past the 60s cap, so
// 5 is sufficient — not tuned to any particular outage length.
export const SPAWN_BACKOFF_CAP_MS = 60_000;
export const SPAWN_BACKOFF_MAX_STREAK = 5;

// [LAW:behavior-not-structure] Pure over the streak; no filesystem. Mirrors
// Rust's effective_cooldown_ms exactly (diffed by check-protocol for the two
// constants; the arithmetic itself is pinned by the boundary unit tests on
// both sides, matching cooldownDecision's existing pattern).
export function effectiveCooldownMs(streak: number): number {
  const capped = Math.min(Math.max(streak, 0), SPAWN_BACKOFF_MAX_STREAK);
  return Math.min(SPAWN_COOLDOWN_MS * 2 ** capped, SPAWN_BACKOFF_CAP_MS);
}

// [LAW:no-defensive-null-guards] Number(raw) — not parseInt — so trailing
// garbage ("5abc", "5.0") fails closed to NaN instead of being silently
// truncated to a plausible-looking integer. parseInt's truncation is exactly
// the bug daemonCeiling() (fork-bomb-breaker.ts, brandon-daemon-lifecycle-gad.2)
// fixed for the same "small integer parsed from an untrusted local file" shape;
// repeating parseInt here would reintroduce it. The clamp to
// SPAWN_BACKOFF_MAX_STREAK also bounds every value this function can ever
// return, so no caller — including `streak + 1` — needs its own re-clamp to
// stay overflow-safe (Rust's mirror clamps at the identical boundary, since a
// raw u32 parsed from disk has no such guarantee otherwise).
// Exported so the parsing-strictness contract (Number, not parseInt — see
// the comment above) has a direct test independent of any caller's file
// content, matching cooldownDecision/effectiveCooldownMs's own exported-for-
// testing precedent.
export function readBackoffStreak(filePath: string): number {
  // [LAW:no-silent-failure] A missing or garbage streak file is NOT
  // ambiguous the way a missing cooldown mtime is: falling back to 0 always
  // fails toward the SAME safe direction as the rest of this module (spawn
  // permitted at the base rate, never wedged) — matching cooldownDecision's
  // own `ageMs === null → allow`. Never loud here; the failure mode is
  // "one extra spawn," which bind() already arbitrates.
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return 0;
    return Math.min(n, SPAWN_BACKOFF_MAX_STREAK);
  } catch {
    return 0;
  }
}

// [LAW:no-ambient-temporal-coupling] The read-then-write here (and in
// claimSpawnCooldown below) is not atomic across process boundaries — two
// client processes racing through a daemon-miss window can both read the
// same streak and both write the same increment, undercounting by one. This
// is an accepted, bounded trade, not an oversight: the ONLY failure direction
// is undercounting (the streak can never advance faster than reality), so a
// race just means backoff ramps a little slower than ideal — it can never
// permit MORE spawning than a race-free count would. The hard rate ceiling
// remains spawn.cooldown's mtime gate, which spawn.lock already serializes
// for the common case; this file, like spawn.lock's own documented
// thundering-herd tolerance, is a best-effort optimization on top of that,
// not a second load-bearing lock.
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

// Called once by the daemon (server.ts onListening) the moment it binds the
// socket — the one process-wide fact that answers "did an outage just end."
// Deletes rather than writes "0": absence already reads as streak 0 via
// readBackoffStreak's catch branch, so there is no separate reset format to
// keep in sync with the normal write path.
//
// [LAW:no-ambient-temporal-coupling] This fires on bind, not on confirmed
// sustained liveness — in the vanishingly rare socket-capture race
// documented above armOwnershipWatch (server.ts), a daemon that only THINKS
// it converged resets the streak early. That daemon self-heals the same way
// ownership does (armOwnershipWatch drains it once the mismatch is detected);
// worst case is one redundant reset in an already-rare race window, not a
// wrong steady-state outcome.
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

// [LAW:single-enforcer] The sole authority on daemon-spawn RATE. Returns true —
// and RECORDS the attempt (updating spawn.cooldown's mtime to now, advancing
// spawn.backoff's streak) — when a spawn is permitted; false when an attempt
// was recorded within the EFFECTIVE cooldown window (SPAWN_COOLDOWN_MS,
// widened by effectiveCooldownMs(streak) once consecutive attempts have
// failed to converge — see brandon-daemon-lifecycle-gad.3). Recording-on-grant
// (BEFORE the caller spawns) is load-bearing: a spawn that then throws or
// returns false still counts against the rate, so a broken binary is not
// retried in a tight loop. A future-mtime garbage record warns loudly and
// falls toward ALLOWING the spawn [LAW:no-silent-failure].
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
  // [LAW:dataflow-not-control-flow] Every granted spawn advances the streak
  // by exactly one, unconditionally — the cap lives in the read side
  // (effectiveCooldownMs) and here (Math.min), never as a skip.
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
  // [LAW:composability] Self-sufficient — ensure the state dir exists rather
  // than leaning on an ambient ensureStateDir() precondition, so any spawn site
  // routing through claimSpawnCooldown records correctly (mirrors Rust's
  // record_spawn_attempt). Content is human-diagnostic only; the mtime is the
  // authority. A write failure means no cooldown recorded — worst case one extra
  // spawn, which bind() arbitrates — but surface it loudly rather than silently
  // un-bound the rate [LAW:no-silent-failure].
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

// Exported for the cooldownDecision boundary tests. Mirrored TS↔Rust (diffed by
// check-protocol) since both runtimes apply it to the same spawn.cooldown file.
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
      // ENOENT means someone (the rightful holder, or another reclaimer)
      // already removed the file — that's the desired post-condition, so
      // continue to the retry. Other failures (EACCES, ENOSPC) are real.
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
// [LAW:one-source-of-truth] The V8 old-space cap is derived from the daemon's
// RSS budget (limits.ts: heapCapMb), never a literal here — the cap must sit
// ABOVE the RSS backstop so the graceful path fires first, and only one owner
// of the budget can keep that order true. The Rust client derives the same
// value the same way (rust-client/src/launch.rs).
//
// [LAW:single-enforcer] Routes through src/proc/launch so daemon-spawn shows
// up in subprocess metering (category "daemon-spawn"). The launch primitive
// owns the only child_process import in this file.
function spawnDaemonDetachedReal(): boolean {
  const node = process.execPath;
  const script = process.argv[1];
  if (!script) return false;
  // [LAW:no-silent-fallbacks] launchDetachedSync returns the typed outcome
  // synchronously, so the spawn-failure case (ENOENT, EACCES, EAGAIN under
  // process-table pressure) propagates as `false` instead of being silently
  // reported as success. The previous `void launch({detached:true})` form
  // discarded the Promise and unconditionally returned true.
  const result = launchDetachedSync({
    bin: node,
    args: [`--max-old-space-size=${heapCapMb(process.env)}`, script, "daemon"],
    category: "daemon-spawn",
  });
  return result.ok;
}
