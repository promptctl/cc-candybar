import fs from "node:fs";
import process from "node:process";

// ─── Socket ownership lease ──────────────────────────────────────────────────
//
// [LAW:one-source-of-truth] The authority for "who owns this socket path" is a
// lease file DERIVED FROM the socket path (one lease per socket identity), not a
// connect probe. The prior probe (connect + classify the error code) was a
// representation lie on macOS/BSD: connect(2) on a LIVE AF_UNIX listener whose
// accept backlog is full returns ECONNREFUSED — indistinguishable from a dead
// socket — so under load the probe judged healthy-but-slow daemons dead and
// their sockets were stolen, minting immortal orphans (see
// brandon-daemon-lifecycle-2b3).
//
// [FRAMING:representation] The lease records the owner's pid; liveness is
// kill(pid, 0) — the kernel's process table, which is load-independent truth
// about process existence. A connect sample is load-dependent hearsay and must
// never be the authority that destroys another daemon's socket.

// What a lease read yielded. Distinguishing absent / unreadable / owned keeps
// the arbitration decision a full enumeration over raw inputs (see
// arbitrateSocket) rather than collapsing the ambiguous cases early.
export type LeaseRead =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "owned"; pid: number };

// The EADDRINUSE arbitration outcome. The path already exists (something bound
// it or a stale file remains); this says whether a LIVE owner holds it.
export type SocketArbitration =
  | { kind: "attach-and-exit"; reason: string }
  | { kind: "reclaim"; reason: string };

// Diagnostic-rich lease payload. `pid` is the authority (liveness); the rest is
// operator diagnostics carried in the same file so the lease subsumes the old
// diagnostic pidfile — one file, one identity root.
export interface LeaseRecord {
  pid: number;
  version: number;
  binPath: string | undefined;
  startedAt: string;
}

// [LAW:effects-at-boundaries][LAW:dataflow-not-control-flow] The whole
// arbitration is a pure fold: (raw lease read, injected liveness predicate) →
// decision. kill(2) is the sole effect and it is injected, so every branch is
// exercised by input enumeration with no real processes. Full input space:
//   owned + alive  → attach-and-exit (a live owner holds the path; we are a
//                    duplicate — exit so the incumbent keeps serving)
//   owned + dead   → reclaim (owner crashed; the socket is stale)
//   absent         → reclaim (no lease to consult — a pre-lease or crashed
//                    daemon left a stale socket; prefer availability)
//   unreadable     → reclaim (can't prove a live owner — same)
//
// Failure directions:
//   false-dead (steal a live socket) — made self-healing by the ownership
//     self-check (brandon-daemon-lifecycle-2b3.2).
//   false-alive (the lease pid is alive but is NOT this daemon — a crashed
//     daemon's pid recycled to an unrelated process) — we attach-and-exit
//     without serving. Short-lived recycle self-corrects next tick; a LONG-LIVED
//     recycle reads alive on every start, so no daemon comes up until the stale
//     lease is cleared. Fully closing this needs a pid-identity fingerprint
//     (process start-time, or an fd/flock held for the daemon's lifetime) — the
//     lock-based liveness the epic deferred. connect() can't substitute: it
//     can't tell a busy-live daemon with a full accept backlog (ECONNREFUSED —
//     the exact storm this replaces) from a recycled non-daemon pid. It is
//     strictly rarer than that storm (needs an unclean death skipping lease
//     cleanup AND a pid recycle to a long-lived process within the respawn
//     window).
// Reclaiming on missing/unreadable is the availability-preferring direction — a
// stale socket with no reclaimer is a hard no-service stall, strictly worse than
// a transient double-serve that self-heals.
export function arbitrateSocket(
  read: LeaseRead,
  isAlive: (pid: number) => boolean,
): SocketArbitration {
  if (read.kind === "owned") {
    return isAlive(read.pid)
      ? {
          kind: "attach-and-exit",
          reason: `live owner pid=${read.pid} holds the socket`,
        }
      : { kind: "reclaim", reason: `owner pid=${read.pid} is gone (ESRCH)` };
  }
  if (read.kind === "absent") {
    return {
      kind: "reclaim",
      reason: "no lease — stale socket, no live owner",
    };
  }
  return {
    kind: "reclaim",
    reason: `unreadable lease (${read.detail}) — cannot prove a live owner`,
  };
}

// [LAW:no-silent-failure] Every non-happy path becomes a typed `unreadable`
// with the reason inline, never a swallowed default that pretends the lease said
// something. ENOENT is the one benign case → `absent`.
export function readLease(leasePath: string): LeaseRead {
  let raw: string;
  try {
    raw = fs.readFileSync(leasePath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return {
      kind: "unreadable",
      detail: `read failed: ${(e as Error).message}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: "unreadable", detail: `bad JSON: ${(e as Error).message}` };
  }
  const pid = (parsed as { pid?: unknown } | null)?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return {
      kind: "unreadable",
      detail: `no valid pid (got ${JSON.stringify(pid)})`,
    };
  }
  return { kind: "owned", pid };
}

// Write our lease after we win the bind. Overwrite-on-write: whoever holds the
// socket right now replaces whatever stale lease a dead owner left.
//
// [LAW:no-ambient-temporal-coupling] Atomic publish: write a uniquely-named temp
// sibling then rename onto the lease path. POSIX rename within a directory is
// atomic, so a concurrent reader (a second daemon's EADDRINUSE arbitration) sees
// either the old lease or the complete new one — never a truncated/empty file
// mid-write, which would read as `unreadable` and force a false reclaim of this
// daemon's live socket. The unique temp name means it is always freshly created,
// so its 0600 mode always applies (0600 has no group/world bits for any umask to
// need re-tightening) and rename carries that mode across. Returns null on
// success, a reason on failure.
export function writeLease(
  leasePath: string,
  record: LeaseRecord,
): string | null {
  const tmp = `${leasePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, leasePath);
    return null;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Temp may not exist (write failed before create); nothing to clean.
    }
    return (e as Error).message;
  }
}

// [LAW:one-source-of-truth] Only the owner mutates its lease. A daemon that was
// displaced (its socket stolen, the thief wrote a new lease) must NOT delete the
// current owner's lease on its way out — that would make the next EADDRINUSE
// read `absent` and reclaim the live thief's socket, cascading the theft. So
// remove only when the lease still names us.
export function removeLeaseIfOwned(leasePath: string, myPid: number): void {
  const read = readLease(leasePath);
  if (read.kind === "owned" && read.pid === myPid) {
    try {
      fs.unlinkSync(leasePath);
    } catch {
      // Best-effort cleanup; a leftover lease naming a dead pid is harmless
      // (the next daemon reads it, kill(pid,0)→ESRCH, reclaims).
    }
  }
}
