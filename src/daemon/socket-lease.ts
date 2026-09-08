import fs from "node:fs";
import process from "node:process";

import type { ProcessIdentity } from "./process-fingerprint";

// [LAW:one-source-of-truth] Ownership is a lease file derived from the socket
// path, never a connect probe: on macOS/BSD connect(2) on a LIVE listener with a
// full accept backlog returns ECONNREFUSED, so a probe steals healthy sockets.
// [FRAMING:representation] Liveness is "the SAME process is alive": a bare pid
// lies once recycled, so the kernel start-time rides along (null = unknown).

export type LeaseRead =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | ({ kind: "owned" } & ProcessIdentity);

export type SocketArbitration =
  | { kind: "attach-and-exit"; reason: string }
  | { kind: "reclaim"; reason: string };

export interface LeaseRecord extends ProcessIdentity {
  version: number;
  binPath: string | undefined;
}

// [LAW:effects-at-boundaries][LAW:dataflow-not-control-flow] A pure fold over
// the read and an injected liveness predicate. Reclaiming on missing/unreadable
// prefers availability: a stale socket with no reclaimer is a hard stall.
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

// [LAW:no-silent-failure] Every non-happy path is a typed `unreadable`.
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
  // Absent means "unfingerprinted"; a non-string is malformed, never coerced.
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

// [LAW:no-ambient-temporal-coupling] Atomic publish via a unique temp sibling
// and rename, so a concurrent reader never sees a truncated file and falsely
// reclaims this daemon's live socket. The fresh temp also guarantees 0600.
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
    // [LAW:no-silent-failure] ENOENT means the temp was never created; any other
    // unlink error means it leaks, so it rides on the reason.
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

// [LAW:one-source-of-truth] Only the owner mutates its lease: a displaced daemon
// deleting the live owner's would cascade the theft.
export function removeLeaseIfOwned(leasePath: string, myPid: number): void {
  const read = readLease(leasePath);
  if (read.kind === "owned" && read.pid === myPid) {
    try {
      fs.unlinkSync(leasePath);
    } catch {
      // A leftover lease naming a dead pid is harmless; the next daemon reclaims.
    }
  }
}
