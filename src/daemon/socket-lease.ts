import fs from "node:fs";
import process from "node:process";

import type { ProcessIdentity } from "./process-fingerprint";

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
// [FRAMING:representation] The lease records the owner's pid AND its kernel
// start-time (see process-fingerprint.ts). Liveness is "the SAME process is
// still alive" — kill(pid,0) alone lies when a crashed daemon's pid is recycled
// to an unrelated live process (reads `alive` forever → no daemon ever comes up,
// brandon-daemon-lifecycle-2b3.4 RESIDUAL 1). Comparing the start-time makes a
// recycled pid provably a different process. Both signals are the kernel's
// load-independent truth about process identity; a connect sample is
// load-dependent hearsay and must never be the authority that destroys another
// daemon's socket.

// What a lease read yielded. Distinguishing absent / unreadable / owned keeps
// the arbitration decision a full enumeration over raw inputs (see
// arbitrateSocket) rather than collapsing the ambiguous cases early. `startTime`
// is the owner's kernel start-time fingerprint, or null when the writing host
// could not fingerprint (no `ps`) — the reader then falls back to kill(pid,0).
export type LeaseRead =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | ({ kind: "owned" } & ProcessIdentity);

// The EADDRINUSE arbitration outcome. The path already exists (something bound
// it or a stale file remains); this says whether a LIVE owner holds it.
export type SocketArbitration =
  | { kind: "attach-and-exit"; reason: string }
  | { kind: "reclaim"; reason: string };

// Diagnostic-rich lease payload. `(pid, startTime)` is the authority (process
// identity → liveness); the rest is operator diagnostics carried in the same
// file so the lease subsumes the old diagnostic pidfile — one file, one identity
// root. `startTime` is the kernel start-time token (also human-readable, so it
// doubles as the "daemon started at" diagnostic the old `startedAt` gave), or
// null when this host could not fingerprint.
export interface LeaseRecord extends ProcessIdentity {
  version: number;
  binPath: string | undefined;
}

// [LAW:effects-at-boundaries][LAW:dataflow-not-control-flow] The whole
// arbitration is a pure fold: (raw lease read, injected liveness predicate) →
// decision. Reading process identity is the sole effect and it is injected via
// `isSameLiveProcess`, so every branch is exercised by input enumeration with no
// real processes. Full input space:
//   owned + same-live  → attach-and-exit (the SAME live owner holds the path; we
//                        are a duplicate — exit so the incumbent keeps serving)
//   owned + not-same   → reclaim (owner crashed, OR its pid was recycled to an
//                        unrelated process — either way the socket is stale)
//   absent             → reclaim (no lease to consult — a pre-lease or crashed
//                        daemon left a stale socket; prefer availability)
//   unreadable         → reclaim (can't prove a live owner — same)
//
// [LAW:one-source-of-truth] `isSameLiveProcess(pid, startTime)` consults the
// kernel's process identity ((pid, start-time), see process-fingerprint.ts), not
// a bare pid. This closes RESIDUAL 1: a crashed daemon's pid recycled to a
// long-lived process now reads NOT-same (different start-time) → reclaim, so a
// daemon comes up instead of every start attaching to a ghost forever.
//
// Failure directions:
//   false-dead (steal a live socket) — made self-healing by the ownership
//     self-check (brandon-daemon-lifecycle-2b3.2), and now far rarer: the
//     start-time match will not false-negative a live owner unless the host
//     cannot fingerprint at all, in which case sameLiveProcess falls back to
//     kill(pid,0) — the prior behavior, no worse.
// Reclaiming on missing/unreadable is the availability-preferring direction — a
// stale socket with no reclaimer is a hard no-service stall, strictly worse than
// a transient double-serve that self-heals.
export function arbitrateSocket(
  read: LeaseRead,
  isSameLiveProcess: (pid: number, startTime: string | null) => boolean,
): SocketArbitration {
  if (read.kind === "owned") {
    return isSameLiveProcess(read.pid, read.startTime)
      ? {
          kind: "attach-and-exit",
          reason: `live owner pid=${read.pid} holds the socket`,
        }
      : {
          kind: "reclaim",
          reason: `owner pid=${read.pid} is gone or recycled`,
        };
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
  const record = parsed as { pid?: unknown; startTime?: unknown } | null;
  const pid = record?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return {
      kind: "unreadable",
      detail: `no valid pid (got ${JSON.stringify(pid)})`,
    };
  }
  // startTime is the process fingerprint. A present value must be a string;
  // absent/null means "unfingerprinted" (an older lease, or a host without
  // `ps`) and the reader falls back to kill(pid,0). A present-but-non-string is
  // malformed → unreadable (never silently coerce a lie into a fingerprint).
  const rawStartTime = record?.startTime;
  if (
    rawStartTime !== undefined &&
    rawStartTime !== null &&
    typeof rawStartTime !== "string"
  ) {
    return {
      kind: "unreadable",
      detail: `invalid startTime (got ${JSON.stringify(rawStartTime)})`,
    };
  }
  return { kind: "owned", pid, startTime: rawStartTime ?? null };
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
    const reason = (e as Error).message;
    // [LAW:no-silent-failure] Best-effort temp cleanup, but don't swallow a real
    // failure: ENOENT means the temp was never created (write failed first) —
    // benign; any other unlink error means the temp WAS created and now leaks,
    // so append it to the reason rather than hiding it behind the primary error.
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
        return `${reason}; also failed to remove temp ${tmp}: ${(cleanupErr as Error).message}`;
      }
    }
    return reason;
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
