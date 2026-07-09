import fs from "node:fs";
import { type DaemonLogger } from "./log";
import { type LeaseRead } from "./socket-lease";

// ─── Socket ownership self-check ─────────────────────────────────────────────
//
// [LAW:single-enforcer] "Serving implies owning the socket path" is a temporal
// invariant every daemon component assumes and none enforced. The socket-theft
// storm (brandon-daemon-lifecycle-2b3) proved it false: a daemon whose socket
// was unlinked + rebound by a reclaimer kept running forever (no idle shutdown,
// no watchdog in production, RSS backstop only), holding ~400MB each — 28
// daemons bound in one hour with ZERO voluntary exits. This module is that
// invariant's single enforcer: a displaced daemon exits within one check
// interval, making ANY displacement self-healing regardless of which bug caused
// it.
//
// [FRAMING:representation] Ownership of a filesystem entry IS its kernel
// identity: (st_dev, st_ino). We never unlink + rebind our OWN socket during our
// lifetime, so that identity is stable for as long as we hold the path. A
// reclaimer that displaces us unlinks the path and binds a fresh socket → a NEW
// inode (or, briefly, no file at all). So "the identity now equals the identity
// I bound" is the exact, load-independent test for continued ownership — unlike
// a connect probe, which the sibling .1 removed precisely because it lied under
// load.
//
// [FRAMING:representation] The inode alone leaves ONE hole (RESIDUAL 2, the
// capture race): if a thief completes unlink + rebind inside the sub-millisecond
// window between our bind() and our 'listening' callback, we stat the path and
// capture the THIEF's inode as "ours" — so the inode check reads `owned` forever
// against the wrong identity. We cannot make that captured inode trustworthy (an
// AF_UNIX listener's fstat reports a different namespace's inode than stat(path),
// so there is no race-free "the inode I truly bound"). But a real thief, being a
// daemon, writes its OWN pid into the lease. So ownership requires a SECOND
// condition: the lease must still name us. A displacer must touch one of the two
// representations — steal the socket (inode changes) or overwrite the lease (pid
// changes) — so requiring BOTH drains any orphan within a bounded number of
// intervals. No live process can share our live pid, so the lease pid alone
// distinguishes "the lease still names me" (the start-time fingerprint is only
// needed by the sibling arbitration, which reasons about a possibly-DEAD pid).

// The kernel identity of the bound socket file. (dev, ino) is the unique
// identity of a filesystem entry; ino alone can be reused across devices.
export interface SocketIdentity {
  dev: number;
  ino: number;
}

// What re-reading the socket path's identity yielded. Distinguishing
// present / absent / unreadable keeps the ownership decision a full enumeration
// over raw inputs (see checkOwnership) rather than collapsing the ambiguous
// cases early — the same shape as socket-lease.ts's LeaseRead.
export type IdentityRead =
  | { kind: "present"; identity: SocketIdentity }
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string };

// The self-check outcome. `owned` is the ONLY proof-of-ownership state; every
// other input maps to `displaced` (fail toward exit).
export type OwnershipCheck =
  | { kind: "owned" }
  | { kind: "displaced"; reason: string };

export const DEFAULT_OWNERSHIP_CHECK_INTERVAL_MS = 5000;

// [LAW:no-silent-failure] The sole effect (statSync) is lifted to a typed
// boundary read: ENOENT → `absent` (the path was unlinked, not yet rebound),
// any other error → `unreadable` with the reason inline, never a swallowed
// default. statSync (not lstatSync) follows a symlink deliberately — it reads
// the identity of whatever a CLIENT connecting to the path would actually reach,
// which is exactly what "do I still own what clients hit" asks.
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

// [LAW:effects-at-boundaries][LAW:dataflow-not-control-flow] A pure fold:
// (identity captured at bind, current identity read, my pid, current lease read)
// → decision. No effects, so every branch is exercised by input enumeration.
// Ownership is the CONJUNCTION of two conditions; either failing → displaced:
//   inode:  present + same identity as bound     (we still hold the path we bound)
//   lease:  owned + pid == mine                  (the lease still names us)
// Inode failures:  different inode / absent / unreadable → a reclaimer displaced
//   us (or we cannot prove otherwise). Lease failures: a thief overwrote the
//   lease with its own pid, or the lease vanished/broke — either way we no
//   longer hold the authority.
//
// [FRAMING:representation] Only "still holding my bound socket AND still named by
// the lease" proves ownership; anything short is `displaced`. This is the
// strongest-true theorem for "serving implies owning", checked against BOTH
// mutable representations a displacer can touch. The failure direction is
// deliberately safe — a false `displaced` (exit while actually owning) just lets
// the real owner serve and the next client respawns; a false `owned` is the
// immortal orphan we are killing. Always err toward exit.
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

// Returns the displacement reason if the current path identity no longer matches
// what we bound, or null if the inode still proves ownership.
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

// [LAW:locality-or-seam] The identity read, the shutdown funnel, and the log
// sink are injected, not reached for ambiently — so a unit test drives every
// branch (swap the inode, delete the path) against a fake shutdown with no real
// daemon, mirroring makeLimits. The real wiring injects
// `() => readSocketIdentity(sockPath)` and the daemon's single shutdown().
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
  // Run one check now; funnels through shutdown(0) on the first `displaced`.
  // Returns the decision so callers/tests can assert without timers.
  check(): OwnershipCheck;
  arm(intervalMs?: number): { disarm(): void };
}

export function makeOwnershipWatch(
  deps: OwnershipWatchDeps,
): OwnershipWatchHandle {
  // [LAW:single-enforcer] Latch like limits' `triggered`: displacement funnels
  // shutdown exactly once (one log line, one shutdown call), even though
  // shutdown() is itself idempotent. Serving implies owning through ONE exit.
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
      // [LAW:no-ambient-temporal-coupling] Self-disarm once displaced: the watch
      // has funneled its single shutdown, so stop polling — no zombie statSync
      // fires during the shutdown window (a hung shutdown reaches its SIGKILL
      // backstop at 500ms). The timer's whole lifecycle lives here in arm(),
      // mirroring armBinaryWatch which clears its interval before shutting down.
      if (check().kind === "displaced") clearInterval(timer);
    }, intervalMs);
    // unref so the check never keeps the process alive on its own — it only ever
    // hastens an exit, never delays one.
    timer.unref();
    return { disarm: () => clearInterval(timer) };
  }

  return { check, arm };
}
