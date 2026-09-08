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

// The real kernel start-time of a live pid, so a planted lease matches the identity `ps` reads back.
function realStartTime(pid: number): string {
  const r = readStartTime(pid);
  if (r.kind !== "start") {
    throw new Error(`expected a live start-time for pid ${pid}, got ${r.kind}`);
  }
  return r.token;
}

// [LAW:effects-at-boundaries] arbitrateSocket is a pure fold; every branch is exercised with a stub predicate.

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

  // BOTH pid and start-time — the pair that distinguishes a recycled pid.
  test("forwards pid AND startTime to the injected predicate", () => {
    const isSame = jest.fn(() => true);
    arbitrateSocket(owned(999, "Thu Jul  9 05:04:25 2026"), isSame);
    expect(isSame).toHaveBeenCalledWith(999, "Thu Jul  9 05:04:25 2026");
  });

  // [LAW:no-silent-failure] Identity, not connectability: a busy-but-live daemon is still live.
  test("liveness comes only from the injected predicate, never from connect", () => {
    const record = owned(999);
    expect(arbitrateSocket(record, () => true).kind).toBe("attach-and-exit");
    expect(arbitrateSocket(record, () => false).kind).toBe("reclaim");
  });
});

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
    expect(fs.statSync(leasePath).mode & 0o077).toBe(0);
  });

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

  // An OLD lease with no startTime reads as unfingerprinted, not unreadable.
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
    // [LAW:no-silent-failure] A non-string startTime is a lie we refuse to coerce.
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

  // [LAW:one-source-of-truth] A displaced daemon must NOT delete the current owner's lease.
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

// [LAW:behavior-not-structure] The incumbent's "socket" is a PLAIN FILE, so connect() returns the exact error the deleted probe called "dead".

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

// [LAW:behavior-not-structure] Signal 0 probes existence; EPERM still means alive.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
      expect(holder.pid).toBeDefined();
      const holderPid = holder.pid as number;
      // A stale plain file at the socket path: bind → EADDRINUSE, connect → ENOTSOCK.
      const MARKER = "INCUMBENT-SOCKET-DO-NOT-DELETE";
      fs.writeFileSync(fx.sockPath, MARKER);
      // The REAL kernel start-time, so arbitration proves the SAME process owns it.
      writeLease(fx.leasePath, {
        pid: holderPid,
        version: 2,
        binPath: "/incumbent",
        startTime: realStartTime(holderPid),
      });

      const { child: daemon, killTree, release } = await spawnTestDaemon(fx.env);
      try {
        const result = await raceExit(daemon, BUDGET_MS);
        expect(result).not.toBe("timeout");
        expect(result).toMatchObject({ code: 0 });
        expect(fs.readFileSync(fx.sockPath, "utf8")).toBe(MARKER);
      } finally {
        // killTree signals the whole group: the tsx wrapper forks the worker that binds.
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
        const connectable = await waitForConnectable(fx.sockPath, BUDGET_MS);
        expect(connectable).toBe(true);
        const released = readLease(fx.leasePath);
        expect(released.kind).toBe("owned");
        if (released.kind === "owned") {
          // The lease names a LIVE owner — aliveness, never the pid's value.
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

  // A crashed daemon's pid recycled to a live process: kill(pid,0) alone would attach forever.
  test("recycled pid (live pid, mismatched start-time): daemon comes up and serves", async () => {
    const fx = makeFixture();
    const holder = spawnLiveHolder();
    try {
      expect(holder.pid).toBeDefined();
      const recycledPid = holder.pid as number;

      fs.writeFileSync(fx.sockPath, "STALE-SOCKET-FROM-CRASHED-DAEMON");
      writeLease(fx.leasePath, {
        pid: recycledPid,
        version: 2,
        binPath: "/crashed",
        // A start-time that cannot be the live holder's — the mismatch forces the reclaim.
        startTime: "Thu Jan  1 00:00:00 1970",
      });

      const { child: daemon, killTree, release } = await spawnTestDaemon(fx.env);
      try {
        const connectable = await waitForConnectable(fx.sockPath, BUDGET_MS);
        expect(connectable).toBe(true);
        const released = readLease(fx.leasePath);
        expect(released.kind).toBe("owned");
        if (released.kind === "owned") {
          // A LIVE owner: aliveness, invariant under the pid reuse this case is built around.
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
