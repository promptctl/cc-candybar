import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  arbitrateSocket,
  readLease,
  removeLeaseIfOwned,
  writeLease,
  type LeaseRead,
} from "../src/daemon/socket-lease";
import { readStartTime } from "../src/daemon/process-fingerprint";
import { spawnTestDaemon } from "./helpers/spawn-test-daemon";

// The real kernel start-time of a live pid, so a planted lease matches the true
// process identity the daemon's arbitration reads back via `ps`.
function realStartTime(pid: number): string {
  const r = readStartTime(pid);
  if (r.kind !== "start") {
    throw new Error(`expected a live start-time for pid ${pid}, got ${r.kind}`);
  }
  return r.token;
}

// ─── Pure arbitration: full input-space enumeration ──────────────────────────
//
// [LAW:effects-at-boundaries] arbitrateSocket is a pure fold over (lease read,
// injected liveness). Every branch is exercised here with a stub predicate and
// no real processes — this is the load-bearing correctness test for the
// socket-theft fix (the integration tests below only prove the wiring).

describe("arbitrateSocket (pure decision)", () => {
  const SAME = (): boolean => true;
  const NOT_SAME = (): boolean => false;
  const owned = (pid: number, startTime: string | null = "st"): LeaseRead => ({
    kind: "owned",
    pid,
    startTime,
  });

  test("owned + same-live → attach-and-exit (a live owner holds the socket)", () => {
    const d = arbitrateSocket(owned(4242), SAME);
    expect(d.kind).toBe("attach-and-exit");
    expect(d.reason).toContain("4242");
  });

  test("owned + not-same → reclaim (owner crashed OR pid recycled)", () => {
    const d = arbitrateSocket(owned(4242), NOT_SAME);
    expect(d.kind).toBe("reclaim");
    expect(d.reason).toContain("4242");
  });

  test("absent → reclaim (no lease; stale socket, no live owner)", () => {
    // The liveness predicate must not even be consulted when there is no pid.
    const isSame = jest.fn(() => true);
    const d = arbitrateSocket({ kind: "absent" }, isSame);
    expect(d.kind).toBe("reclaim");
    expect(isSame).not.toHaveBeenCalled();
  });

  test("unreadable → reclaim (cannot prove a live owner)", () => {
    const isSame = jest.fn(() => true);
    const d = arbitrateSocket(
      { kind: "unreadable", detail: "bad JSON" },
      isSame,
    );
    expect(d.kind).toBe("reclaim");
    expect(d.reason).toContain("bad JSON");
    expect(isSame).not.toHaveBeenCalled();
  });

  // The predicate receives BOTH the pid and the lease's start-time token — the
  // process-identity pair that lets a recycled pid be distinguished from the
  // original owner (RESIDUAL 1). arbitrateSocket forwards them verbatim; the
  // sameLiveProcess fold (process-fingerprint) decides.
  test("forwards pid AND startTime to the injected predicate", () => {
    const isSame = jest.fn(() => true);
    arbitrateSocket(owned(999, "Thu Jul  9 05:04:25 2026"), isSame);
    expect(isSame).toHaveBeenCalledWith(999, "Thu Jul  9 05:04:25 2026");
  });

  // [LAW:no-silent-failure] The failure DIRECTION is the whole safety argument:
  // a busy-but-live daemon (backlog full — the ECONNREFUSED case that fooled the
  // old connect probe) is judged by process identity, which is load-independent.
  // As long as the SAME process is alive, arbitration attaches-and-exits
  // regardless of whether it is currently accepting connections.
  test("liveness comes only from the injected predicate, never from connect", () => {
    const record = owned(999);
    expect(arbitrateSocket(record, () => true).kind).toBe("attach-and-exit");
    expect(arbitrateSocket(record, () => false).kind).toBe("reclaim");
  });
});

// ─── Lease file I/O ──────────────────────────────────────────────────────────

describe("lease file I/O", () => {
  let dir: string;
  let leasePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-lease-"));
    leasePath = path.join(dir, "socket.lease");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("readLease: absent file → absent", () => {
    expect(readLease(leasePath)).toEqual({ kind: "absent" });
  });

  test("writeLease → readLease round-trips the owner pid AND start-time", () => {
    const err = writeLease(leasePath, {
      pid: 1234,
      version: 2,
      binPath: "/x/y",
      startTime: "Thu Jul  9 05:04:25 2026",
    });
    expect(err).toBeNull();
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 1234,
      startTime: "Thu Jul  9 05:04:25 2026",
    });
    // 0600 — never group/world readable.
    expect(fs.statSync(leasePath).mode & 0o077).toBe(0);
  });

  // A host that could not fingerprint (no `ps`) writes a null start-time; the
  // reader surfaces it as null so sameLiveProcess falls back to kill(pid,0).
  test("writeLease → readLease round-trips a null start-time (unfingerprinted)", () => {
    writeLease(leasePath, {
      pid: 1234,
      version: 2,
      binPath: undefined,
      startTime: null,
    });
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 1234,
      startTime: null,
    });
  });

  // Backward-compat: an OLD lease with no startTime key reads as unfingerprinted
  // (null), NOT unreadable — so an in-place upgrade doesn't force a false reclaim.
  test("readLease: a lease missing startTime entirely → owned with null", () => {
    fs.writeFileSync(leasePath, JSON.stringify({ pid: 55, version: 2 }));
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 55,
      startTime: null,
    });
  });

  test("readLease: non-JSON → unreadable, not a crash", () => {
    fs.writeFileSync(leasePath, "not json at all");
    const r = readLease(leasePath);
    expect(r.kind).toBe("unreadable");
  });

  test.each([
    ["missing pid", JSON.stringify({ version: 2 })],
    ["non-integer pid", JSON.stringify({ pid: 3.5 })],
    ["non-positive pid", JSON.stringify({ pid: 0 })],
    ["string pid", JSON.stringify({ pid: "123" })],
    // [LAW:no-silent-failure] A present-but-non-string startTime is a lie we
    // refuse to coerce into a fingerprint.
    ["non-string startTime", JSON.stringify({ pid: 9, startTime: 42 })],
  ])("readLease: %s → unreadable", (_label, contents) => {
    fs.writeFileSync(leasePath, contents);
    expect(readLease(leasePath).kind).toBe("unreadable");
  });

  test("removeLeaseIfOwned: removes when the lease names us", () => {
    writeLease(leasePath, {
      pid: 777,
      version: 2,
      binPath: undefined,
      startTime: "t",
    });
    removeLeaseIfOwned(leasePath, 777);
    expect(fs.existsSync(leasePath)).toBe(false);
  });

  // [LAW:one-source-of-truth] A displaced daemon must NOT delete the current
  // owner's lease — that would cascade the theft (next EADDRINUSE reads absent
  // → reclaims the live thief's socket).
  test("removeLeaseIfOwned: keeps a lease owned by someone else", () => {
    writeLease(leasePath, {
      pid: 888,
      version: 2,
      binPath: undefined,
      startTime: "t",
    });
    removeLeaseIfOwned(leasePath, 777);
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 888,
      startTime: "t",
    });
  });

  test("removeLeaseIfOwned: no-op on an absent lease", () => {
    expect(() => removeLeaseIfOwned(leasePath, 777)).not.toThrow();
  });
});

// ─── Integration: the storm shape, against a real daemon ─────────────────────
//
// [LAW:behavior-not-structure] These spawn the real daemon binary and drive its
// EADDRINUSE arbitration end-to-end. The incumbent's "socket" is a PLAIN FILE —
// connect() to it returns exactly the ECONNREFUSED/ENOTSOCK the deleted probe
// classified as "dead". So this is the bug's exact trigger; the lease is what
// keeps the incumbent from being robbed.

const BUDGET_MS = 8000;

interface Fixture {
  sockPath: string;
  leasePath: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-slt-"));
  const stateDir = path.join(stateRoot, "cc-candybar");
  // ensureSocketParentSafe requires uid==me + mode 0700 on the socket parent.
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sockPath = path.join(stateDir, "socket");
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-slt-c-"));
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-slt-g-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CC_CANDYBAR_SOCKET: sockPath,
    XDG_STATE_HOME: stateRoot,
    XDG_CACHE_HOME: cacheHome,
    XDG_CONFIG_HOME: configHome,
  };
  return {
    sockPath,
    leasePath: `${sockPath}.lease`,
    env,
    cleanup: () => {
      for (const d of [stateRoot, cacheHome, configHome]) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function raceExit(
  child: ChildProcess,
  budgetMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | "timeout"> {
  return Promise.race([
    waitForExit(child),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), budgetMs).unref(),
    ),
  ]);
}

async function waitForConnectable(
  sockPath: string,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(sockPath);
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 25).unref());
  }
  return false;
}

// Does this pid name a live process? Signal 0 probes existence without
// delivering a signal: it returns for a live pid, throws ESRCH for a dead one,
// and throws EPERM for a live pid we may not signal (still alive). We assert on
// the *aliveness*, never on the pid's numeric value — so this stays behavior,
// not numbering, and is invariant under pid reuse. [LAW:behavior-not-structure]
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A live process whose pid we control — the "incumbent" whose lease the daemon
// under test must honour. It never accepts on the socket; its only relevant
// property is that its pid is alive.
function spawnLiveHolder(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], {
    stdio: "ignore",
  });
}

describe("daemon EADDRINUSE arbitration (integration)", () => {
  jest.setTimeout(30_000);

  test("live-lease incumbent: second daemon exits 0 and does NOT unlink the socket", async () => {
    const fx = makeFixture();
    const holder = spawnLiveHolder();
    try {
      // A missing pid would make the lease omit `pid` → readLease `unreadable`
      // → reclaim, passing this test for the wrong reason. Assert it up front.
      expect(holder.pid).toBeDefined();
      const holderPid = holder.pid as number;
      // Plant a stale plain file at the socket path (bind → EADDRINUSE; connect
      // → ENOTSOCK/ECONNREFUSED, i.e. the old probe's "dead" verdict) plus a
      // lease naming the LIVE holder pid.
      const MARKER = "INCUMBENT-SOCKET-DO-NOT-DELETE";
      fs.writeFileSync(fx.sockPath, MARKER);
      // The lease carries the holder's REAL kernel start-time, so the daemon's
      // arbitration reads it back via `ps` and proves the SAME live process still
      // owns the socket → attach-and-exit (the fingerprint-match path).
      writeLease(fx.leasePath, {
        pid: holderPid,
        version: 2,
        binPath: "/incumbent",
        startTime: realStartTime(holderPid),
      });

      const { child: daemon, killTree, release } = await spawnTestDaemon(fx.env);
      try {
        const result = await raceExit(daemon, BUDGET_MS);
        // Exits cleanly (attach-and-exit), never SIGKILL/crash.
        expect(result).not.toBe("timeout");
        expect(result).toMatchObject({ code: 0 });
        // The incumbent's socket file is untouched — no theft.
        expect(fs.readFileSync(fx.sockPath, "utf8")).toBe(MARKER);
      } finally {
        // killTree signals the whole process group, not just the `tsx`
        // wrapper `daemon` names — the wrapper forks its own worker (the
        // process that actually binds the socket), which survives as an
        // orphan if only the wrapper is signalled.
        killTree();
        release();
      }
    } finally {
      holder.kill("SIGKILL");
      fx.cleanup();
    }
  });

  test("dead-lease incumbent: next daemon reclaims on first attempt and serves", async () => {
    const fx = makeFixture();
    try {
      // A holder we kill, so its pid is dead when the daemon reads the lease.
      const holder = spawnLiveHolder();
      expect(holder.pid).toBeDefined();
      const deadPid = holder.pid as number;
      holder.kill("SIGKILL");
      await waitForExit(holder);

      fs.writeFileSync(fx.sockPath, "STALE-SOCKET-FROM-CRASHED-DAEMON");
      writeLease(fx.leasePath, {
        pid: deadPid,
        version: 2,
        binPath: "/crashed",
        startTime: "Wed Jul  8 00:00:00 2026",
      });

      const { child: daemon, killTree, release } = await spawnTestDaemon(fx.env);
      try {
        // Reclaim → unlink stale socket → rebind → serve. First-attempt
        // reclaim means it becomes connectable without any exit in between.
        const connectable = await waitForConnectable(fx.sockPath, BUDGET_MS);
        expect(connectable).toBe(true);
        // The stale socket was a plain file; a connectable socket here means a
        // live daemon unlinked it, rebound, and now answers — the reclaim. The
        // lease rewritten to `owned` is that same live owner. [LAW:behavior-not-structure]
        const released = readLease(fx.leasePath);
        expect(released.kind).toBe("owned");
        if (released.kind === "owned") {
          // The lease names a LIVE owner, not a dead/bogus pid — the behavioral
          // half of "owned" that `kind` alone can't carry. Stronger than the
          // removed `!== deadPid` (which missed any wrong pid ≠ deadPid) and
          // invariant under pid reuse, so it never false-reds. Not a numbering
          // assertion: we probe the pid's aliveness, never compare its value.
          expect(isPidAlive(released.pid)).toBe(true);
        }
      } finally {
        killTree();
        await waitForExit(daemon);
        release();
      }
    } finally {
      fx.cleanup();
    }
  });

  // RESIDUAL 1 (brandon-daemon-lifecycle-2b3.4): a crashed daemon's pid recycled
  // to an unrelated LIVE process. A bare kill(pid,0) reads `alive` forever, so
  // every start attaches-and-exits and NO daemon ever comes up — the inverse of
  // the socket-theft storm. The start-time fingerprint distinguishes the recycled
  // process (different start-time) → the daemon reclaims and SERVES.
  test("recycled pid (live pid, mismatched start-time): daemon comes up and serves", async () => {
    const fx = makeFixture();
    // A live holder standing in for the process that recycled the crashed
    // daemon's pid. Its pid is alive, but its start-time is NOT the token in the
    // lease, so it is provably a different process.
    const holder = spawnLiveHolder();
    try {
      expect(holder.pid).toBeDefined();
      const recycledPid = holder.pid as number;

      fs.writeFileSync(fx.sockPath, "STALE-SOCKET-FROM-CRASHED-DAEMON");
      writeLease(fx.leasePath, {
        pid: recycledPid,
        version: 2,
        binPath: "/crashed",
        // A start-time that cannot be the live holder's (far in the past) — the
        // fingerprint mismatch is what forces the reclaim.
        startTime: "Thu Jan  1 00:00:00 1970",
      });

      const { child: daemon, killTree, release } = await spawnTestDaemon(fx.env);
      try {
        // Fingerprint mismatch → reclaim → serve, despite the pid being alive.
        const connectable = await waitForConnectable(fx.sockPath, BUDGET_MS);
        expect(connectable).toBe(true);
        // Connectable stale-file socket ⇒ a live daemon reclaimed and serves;
        // `owned` lease ⇒ that live owner now holds it. [LAW:behavior-not-structure]
        const released = readLease(fx.leasePath);
        expect(released.kind).toBe("owned");
        if (released.kind === "owned") {
          // The reclaimed lease names a LIVE owner (the new daemon), not the
          // recycled pid's stale identity. Behavioral, invariant under the pid
          // reuse this very case is built around — we probe aliveness, not the
          // number, so recycledPid == successor pid could never false-red it.
          expect(isPidAlive(released.pid)).toBe(true);
        }
      } finally {
        killTree();
        await waitForExit(daemon);
        release();
      }
    } finally {
      holder.kill("SIGKILL");
      fx.cleanup();
    }
  });
});
