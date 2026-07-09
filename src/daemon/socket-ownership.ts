import fs from "node:fs";
import { type DaemonLogger } from "./log";

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
// (identity captured at bind, current identity read) → decision. No effects, so
// every branch is exercised by input enumeration. Full input space:
//   present + same identity → owned      (we still hold the path we bound)
//   present + different     → displaced  (a reclaimer unlinked + rebound; new inode)
//   absent (ENOENT)         → displaced  (path unlinked, reclaimer not yet rebound)
//   unreadable              → displaced  (cannot PROVE ownership → fail toward exit)
//
// [FRAMING:representation] Only `present + same identity` proves ownership;
// everything else is `displaced`. This is the strongest-true theorem: serving
// must IMPLY owning, so anything short of positive proof drains and exits. The
// failure direction is deliberately safe — a false `displaced` (exit while
// actually owning, e.g. a transient stat error) just lets the real owner/thief
// serve and the next client respawns; a false `owned` is the immortal orphan we
// are killing. Always err toward exit.
export function checkOwnership(
  bound: SocketIdentity,
  now: IdentityRead,
): OwnershipCheck {
  if (now.kind === "present") {
    if (now.identity.dev === bound.dev && now.identity.ino === bound.ino) {
      return { kind: "owned" };
    }
    return {
      kind: "displaced",
      reason: `socket replaced (bound dev=${bound.dev} ino=${bound.ino}, now dev=${now.identity.dev} ino=${now.identity.ino})`,
    };
  }
  if (now.kind === "absent") {
    return {
      kind: "displaced",
      reason: "socket path gone (ENOENT) — unlinked by a reclaimer",
    };
  }
  return {
    kind: "displaced",
    reason: `socket path unreadable (${now.detail}) — cannot prove ownership`,
  };
}

// [LAW:locality-or-seam] The identity read, the shutdown funnel, and the log
// sink are injected, not reached for ambiently — so a unit test drives every
// branch (swap the inode, delete the path) against a fake shutdown with no real
// daemon, mirroring makeLimits. The real wiring injects
// `() => readSocketIdentity(sockPath)` and the daemon's single shutdown().
export interface OwnershipWatchDeps {
  bound: SocketIdentity;
  readIdentity: () => IdentityRead;
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
    const decision = checkOwnership(deps.bound, deps.readIdentity());
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
      check();
    }, intervalMs);
    // [LAW:no-ambient-temporal-coupling] unref so the check never keeps the
    // process alive on its own — it only ever hastens an exit, never delays one.
    timer.unref();
    return { disarm: () => clearInterval(timer) };
  }

  return { check, arm };
}
