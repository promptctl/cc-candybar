import fs from "node:fs";
import { type DaemonLogger } from "./log";
import { type LeaseRead } from "./socket-lease";

// [LAW:single-enforcer] "Serving implies owning the socket path" is a temporal
// invariant nothing else enforced; a displaced daemon exits within one interval.
// [FRAMING:representation] Ownership is the path's kernel identity (dev, ino) — we
// never unlink + rebind our own socket, so a displacer's bind is a NEW inode — AND
// the lease still naming our pid, which closes the capture race where a thief
// rebinding between bind() and 'listening' would be captured as "ours".

// `ino` alone can be reused across devices.
export interface SocketIdentity {
  dev: number;
  ino: number;
}

// Keeps the ownership decision a full enumeration over raw inputs rather than collapsing the ambiguous cases early.
export type IdentityRead =
  | { kind: "present"; identity: SocketIdentity }
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string };

// `owned` is the ONLY proof-of-ownership state; every other input fails toward exit.
export type OwnershipCheck =
  | { kind: "owned" }
  | { kind: "displaced"; reason: string };

export const DEFAULT_OWNERSHIP_CHECK_INTERVAL_MS = 5000;

// [LAW:no-silent-failure] statSync, not lstatSync: the identity a CLIENT connecting to the path would reach.
export function readSocketIdentity(sockPath: string): IdentityRead {
  try {
    const st = fs.statSync(sockPath);
    return { kind: "present", identity: { dev: st.dev, ino: st.ino } };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", detail: (e as Error).message };
  }
}

// [LAW:effects-at-boundaries][LAW:dataflow-not-control-flow] A pure fold, so every
// branch is exercised by input enumeration. Err toward exit: a false `displaced`
// costs a respawn, a false `owned` is the immortal orphan this exists to kill.
export function checkOwnership(
  bound: SocketIdentity,
  now: IdentityRead,
  myPid: number,
  lease: LeaseRead,
): OwnershipCheck {
  const inodeFailure = inodeDisplacement(bound, now);
  if (inodeFailure !== null) {
    return { kind: "displaced", reason: inodeFailure };
  }
  if (lease.kind !== "owned") {
    return {
      kind: "displaced",
      reason: `lease not held (${lease.kind}) — no longer the socket owner`,
    };
  }
  if (lease.pid !== myPid) {
    return {
      kind: "displaced",
      reason: `lease reassigned (names pid=${lease.pid}, we are pid=${myPid}) — a reclaimer overwrote it`,
    };
  }
  return { kind: "owned" };
}

function inodeDisplacement(
  bound: SocketIdentity,
  now: IdentityRead,
): string | null {
  if (now.kind === "present") {
    if (now.identity.dev === bound.dev && now.identity.ino === bound.ino) {
      return null;
    }
    return `socket replaced (bound dev=${bound.dev} ino=${bound.ino}, now dev=${now.identity.dev} ino=${now.identity.ino})`;
  }
  if (now.kind === "absent") {
    return "socket path gone (ENOENT) — unlinked by a reclaimer";
  }
  return `socket path unreadable (${now.detail}) — cannot prove ownership`;
}

// [LAW:locality-or-seam] Identity read, shutdown funnel and log sink are injected, never reached for ambiently.
export interface OwnershipWatchDeps {
  bound: SocketIdentity;
  myPid: number;
  readIdentity: () => IdentityRead;
  readLease: () => LeaseRead;
  shutdown: (code: number) => void;
  log: DaemonLogger;
  intervalMs?: number;
}

export interface OwnershipWatchHandle {
  check(): OwnershipCheck;
  arm(intervalMs?: number): { disarm(): void };
}

export function makeOwnershipWatch(
  deps: OwnershipWatchDeps,
): OwnershipWatchHandle {
  // [LAW:single-enforcer] Displacement funnels shutdown exactly once.
  let displaced = false;

  function check(): OwnershipCheck {
    const decision = checkOwnership(
      deps.bound,
      deps.readIdentity(),
      deps.myPid,
      deps.readLease(),
    );
    if (decision.kind === "displaced" && !displaced) {
      displaced = true;
      deps.log(
        "warn",
        `ownership self-check: ${decision.reason}; shutting down`,
      );
      deps.shutdown(0);
    }
    return decision;
  }

  function arm(
    intervalMs: number = deps.intervalMs ?? DEFAULT_OWNERSHIP_CHECK_INTERVAL_MS,
  ): { disarm(): void } {
    const timer = setInterval(() => {
      // [LAW:no-ambient-temporal-coupling] Self-disarm so no zombie statSync fires during the shutdown window.
      if (check().kind === "displaced") clearInterval(timer);
    }, intervalMs);
    // The check may only hasten an exit, never delay one.
    timer.unref();
    return { disarm: () => clearInterval(timer) };
  }

  return { check, arm };
}
