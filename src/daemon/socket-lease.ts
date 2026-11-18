import fs from "node:fs";

import type { Liveness, ProcessIdentity } from "./process-fingerprint";
import { publishByRename } from "../utils/atomic-write";

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
// arbitration is a fold: (raw lease read, injected liveness fold) → decision.
// Reading process identity is the sole effect and it is injected via
// `livenessOf`, so every branch is exercised by input enumeration with no
// real processes. Full input space:
//   owned + same-live  → attach-and-exit (the SAME live owner holds the path; we
//                        are a duplicate — exit so the incumbent keeps serving)
//   owned + not-same   → reclaim (owner crashed, OR its pid was recycled to an
//                        unrelated process — either way the socket is stale)
//   absent             → reclaim (no lease to consult — a pre-lease or crashed
//                        daemon left a stale socket; prefer availability)
//   unreadable         → reclaim (can't prove a live owner — same)
//
// [LAW:one-source-of-truth] `livenessOf(pid, startTime)` consults the
// kernel's process identity ((pid, start-time), see process-fingerprint.ts), not
// a bare pid. This closes RESIDUAL 1: a crashed daemon's pid recycled to a
// long-lived process now reads NOT-same (different start-time) → reclaim, so a
// daemon comes up instead of every start attaching to a ghost forever.
//
// Failure directions:
//   false-dead (steal a live socket) — made self-healing by the ownership
//     self-check (brandon-daemon-lifecycle-2b3.2), and now far rarer: the
//     start-time match will not false-negative a live owner unless the host
//     cannot fingerprint at all, in which case the liveness fold falls back
//     to kill(pid,0) — the prior behavior, no worse.
// The decision's reason carries the fold's own why, so a line that attached
// to an owner whose start time could not be read says so.
// Reclaiming on missing/unreadable is the availability-preferring direction — a
// stale socket with no reclaimer is a hard no-service stall, strictly worse than
// a transient double-serve that self-heals.
export async function arbitrateSocket(
  read: LeaseRead,
  livenessOf: (pid: number, startTime: string | null) => Promise<Liveness>,
): Promise<SocketArbitration> {
  if (read.kind === "owned") {
    const { live, why } = await livenessOf(read.pid, read.startTime);
    return {
      kind: live ? "attach-and-exit" : "reclaim",
      reason: `owner pid=${read.pid} ${why}`,
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
// [LAW:single-enforcer] Publishing is the lease's one mutation; nothing removes
// a lease. POSIX has no unlink-if-still-mine, so any removal is a check and then
// an unlink of a shared name, and a successor's publish landing between the two
// is the lease the unlink takes. An absent lease drains that successor at its
// next ownership self-check and lets the next EADDRINUSE reclaim its live
// socket. A lease its owner left on exit names a dead process identity, which
// arbitration reclaims exactly as it does an absent one, and the next publish
// replaces it.
//
// [LAW:no-ambient-temporal-coupling] Published by rename, so a concurrent
// reader (a second daemon's EADDRINUSE arbitration) sees either the old lease
// or the complete new one — never a truncated/empty file mid-write, which
// would read as `unreadable` and force a false reclaim of this daemon's live
// socket. Owner-only: 0600 has no group/world bits for any umask to strip.
// Returns null on success, a reason on failure.
export function writeLease(
  leasePath: string,
  record: LeaseRecord,
): string | null {
  try {
    publishByRename(leasePath, JSON.stringify(record), 0o600);
    return null;
  } catch (e) {
    // [LAW:no-silent-failure] The reason is the caller's: a lease that did
    // not land, and any staged file it left, reach whoever wrote it.
    return (e as Error).message;
  }
}
