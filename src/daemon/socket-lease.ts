import fs from "node:fs";

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
// Failure directions: false-alive (pid reuse) only makes us not start this tick
// (safe); false-dead (steal a live socket) is made self-healing by the
// ownership self-check in brandon-daemon-lifecycle-2b3.2. Reclaiming on
// missing/unreadable is the availability-preferring direction — a stale socket
// with no reclaimer is a hard no-service stall, strictly worse than a transient
// double-serve that self-heals.
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
// socket right now overwrites whatever stale lease a dead owner left. 0600 both
// on create (mode) and via explicit chmod (mode arg to writeFileSync only
// applies at creation, so a stale broader-permission file would keep its mode
// without the chmod). Returns null on success, a reason on failure.
export function writeLease(
  leasePath: string,
  record: LeaseRecord,
): string | null {
  try {
    fs.writeFileSync(leasePath, JSON.stringify(record), { mode: 0o600 });
    fs.chmodSync(leasePath, 0o600);
    return null;
  } catch (e) {
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
