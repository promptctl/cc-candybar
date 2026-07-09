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

// ─── Pure arbitration: full input-space enumeration ──────────────────────────
//
// [LAW:effects-at-boundaries] arbitrateSocket is a pure fold over (lease read,
// injected liveness). Every branch is exercised here with a stub predicate and
// no real processes — this is the load-bearing correctness test for the
// socket-theft fix (the integration tests below only prove the wiring).

describe("arbitrateSocket (pure decision)", () => {
  const ALIVE = (): boolean => true;
  const DEAD = (): boolean => false;

  test("owned + alive → attach-and-exit (a live owner holds the socket)", () => {
    const d = arbitrateSocket({ kind: "owned", pid: 4242 }, ALIVE);
    expect(d.kind).toBe("attach-and-exit");
    expect(d.reason).toContain("4242");
  });

  test("owned + dead → reclaim (owner crashed; socket is stale)", () => {
    const d = arbitrateSocket({ kind: "owned", pid: 4242 }, DEAD);
    expect(d.kind).toBe("reclaim");
    expect(d.reason).toContain("4242");
  });

  test("absent → reclaim (no lease; stale socket, no live owner)", () => {
    // The liveness predicate must not even be consulted when there is no pid.
    const isAlive = jest.fn(() => true);
    const d = arbitrateSocket({ kind: "absent" }, isAlive);
    expect(d.kind).toBe("reclaim");
    expect(isAlive).not.toHaveBeenCalled();
  });

  test("unreadable → reclaim (cannot prove a live owner)", () => {
    const isAlive = jest.fn(() => true);
    const d = arbitrateSocket(
      { kind: "unreadable", detail: "bad JSON" },
      isAlive,
    );
    expect(d.kind).toBe("reclaim");
    expect(d.reason).toContain("bad JSON");
    expect(isAlive).not.toHaveBeenCalled();
  });

  // [LAW:no-silent-failure] The failure DIRECTION is the whole safety argument:
  // a busy-but-live daemon (backlog full — the ECONNREFUSED case that fooled
  // the old connect probe) is judged by kill(pid,0), which is load-independent.
  // As long as its pid is alive, arbitration attaches-and-exits regardless of
  // whether it is currently accepting connections.
  test("liveness comes only from the injected predicate, never from connect", () => {
    const record: LeaseRead = { kind: "owned", pid: 999 };
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

  test("writeLease → readLease round-trips the owner pid", () => {
    const err = writeLease(leasePath, {
      pid: 1234,
      version: 2,
      binPath: "/x/y",
      startedAt: new Date().toISOString(),
    });
    expect(err).toBeNull();
    expect(readLease(leasePath)).toEqual({ kind: "owned", pid: 1234 });
    // 0600 — never group/world readable.
    expect(fs.statSync(leasePath).mode & 0o077).toBe(0);
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
  ])("readLease: %s → unreadable", (_label, contents) => {
    fs.writeFileSync(leasePath, contents);
    expect(readLease(leasePath).kind).toBe("unreadable");
  });

  test("removeLeaseIfOwned: removes when the lease names us", () => {
    writeLease(leasePath, {
      pid: 777,
      version: 2,
      binPath: undefined,
      startedAt: "t",
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
      startedAt: "t",
    });
    removeLeaseIfOwned(leasePath, 777);
    expect(readLease(leasePath)).toEqual({ kind: "owned", pid: 888 });
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

const REPO_ROOT = process.cwd();
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
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

function spawnDaemon(env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(TSX_BIN, [ENTRY, "daemon"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
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
      writeLease(fx.leasePath, {
        pid: holderPid,
        version: 2,
        binPath: "/incumbent",
        startedAt: new Date().toISOString(),
      });

      const daemon = spawnDaemon(fx.env);
      try {
        const result = await raceExit(daemon, BUDGET_MS);
        // Exits cleanly (attach-and-exit), never SIGKILL/crash.
        expect(result).not.toBe("timeout");
        expect(result).toMatchObject({ code: 0 });
        // The incumbent's socket file is untouched — no theft.
        expect(fs.readFileSync(fx.sockPath, "utf8")).toBe(MARKER);
      } finally {
        if (daemon.exitCode === null) daemon.kill("SIGKILL");
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
        startedAt: new Date().toISOString(),
      });

      const daemon = spawnDaemon(fx.env);
      try {
        // Reclaim → unlink stale socket → rebind → serve. First-attempt
        // reclaim means it becomes connectable without any exit in between.
        const connectable = await waitForConnectable(fx.sockPath, BUDGET_MS);
        expect(connectable).toBe(true);
        // The lease was rewritten to a live owner — no longer the dead holder.
        // (The pid is the daemon grandchild's, not the tsx shim's, so assert
        // the property, not an exact pid.)
        const released = readLease(fx.leasePath);
        expect(released.kind).toBe("owned");
        if (released.kind === "owned") {
          expect(released.pid).not.toBe(deadPid);
        }
      } finally {
        if (daemon.exitCode === null) daemon.kill("SIGKILL");
        await waitForExit(daemon);
      }
    } finally {
      fx.cleanup();
    }
  });
});
