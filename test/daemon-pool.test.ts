import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createDaemonPool } from "./helpers/daemon-pool";
import { spawnTestDaemon } from "./helpers/spawn-test-daemon";
import { readStartTime } from "../src/daemon/process-fingerprint";

// [LAW:verifiable-goals] The shared-pool primitive's contract in isolation: no real daemon spawns.

// [LAW:single-enforcer] The one cleanup site for every `tmpPoolDir()` in this file.
const createdPoolDirs: string[] = [];
function tmpPoolDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-pool-test-"));
  createdPoolDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdPoolDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  createdPoolDirs.length = 0;
});

describe("daemon pool", () => {
  test("acquires up to `size` slots concurrently, then blocks", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 2);
    const a = await pool.acquire();
    const b = await pool.acquire();
    await expect(
      pool.acquire({ timeoutMs: 300, retryIntervalMs: 50 }),
    ).rejects.toThrow(/no free slot/);
    a.release();
    b.release();
  });

  test("releasing a slot unblocks a pending acquire", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 1);
    const a = await pool.acquire();
    const pending = pool.acquire({ timeoutMs: 5000, retryIntervalMs: 50 });
    // Let the pending acquire reach its poll first, so this exercises the retry path rather than a lucky win.
    await new Promise((r) => setTimeout(r, 100));
    a.release();
    const b = await pending;
    b.release();
  });

  // [LAW:behavior-not-structure] A REAL dead pid, not a fabricated number, which could collide with a live process and flake.
  test("reclaims a slot whose recorded owner is dead", async () => {
    // Kept alive so its start-time is readable: a null startTime drops isSlotLive to a bare kill(pid,0) a recycled pid could satisfy.
    const dead = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      stdio: "ignore",
    });
    const deadPid = dead.pid!;
    const startTimeRead = readStartTime(deadPid);
    const deadStartTime = startTimeRead.kind === "start" ? startTimeRead.token : null;
    dead.kill("SIGKILL");
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));

    const pool = createDaemonPool(tmpPoolDir(), 1);
    fs.mkdirSync(pool.dir, { recursive: true });
    fs.writeFileSync(
      path.join(pool.dir, "slot-0.json"),
      JSON.stringify({ pid: deadPid, startTime: deadStartTime }),
    );

    const slot = await pool.acquire({ timeoutMs: 2000, retryIntervalMs: 50 });
    slot.release();
  });

  test("release is a no-op if the slot was already reclaimed by someone else", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 1);
    const a = await pool.acquire();
    // release() must not blow away the record of a process that reclaimed the slot after we lost ownership.
    fs.writeFileSync(
      path.join(pool.dir, "slot-0.json"),
      JSON.stringify({ pid: 999999, startTime: null }),
    );
    a.release();
    expect(
      JSON.parse(fs.readFileSync(path.join(pool.dir, "slot-0.json"), "utf8")),
    ).toEqual({ pid: 999999, startTime: null });
  });

  test("sweepStale removes only dead-owner slots, never live ones", async () => {
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    const deadPid = dead.pid!;

    const pool = createDaemonPool(tmpPoolDir(), 2);
    fs.mkdirSync(pool.dir, { recursive: true });
    fs.writeFileSync(
      path.join(pool.dir, "slot-0.json"),
      JSON.stringify({ pid: deadPid, startTime: null }),
    );
    fs.writeFileSync(
      path.join(pool.dir, "slot-1.json"),
      JSON.stringify({ pid: process.pid, startTime: null }),
    );

    pool.sweepStale();

    expect(fs.existsSync(path.join(pool.dir, "slot-0.json"))).toBe(false);
    expect(fs.existsSync(path.join(pool.dir, "slot-1.json"))).toBe(true);
  });
});

// [LAW:verifiable-goals] The ceiling proved against REAL daemon subprocesses, on an isolated size-2 pool.
describe("daemon pool caps real daemon subprocesses (integration)", () => {
  jest.setTimeout(30_000);

  interface Fixture {
    sockPath: string;
    env: NodeJS.ProcessEnv;
    cleanup(): void;
  }

  function makeFixture(prefix: string): Fixture {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}c-`));
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}g-`));
    const stateDir = path.join(stateRoot, "cc-candybar");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const sockPath = path.join(stateDir, "socket");
    return {
      sockPath,
      env: {
        ...process.env,
        CC_CANDYBAR_SOCKET: sockPath,
        XDG_STATE_HOME: stateRoot,
        XDG_CACHE_HOME: cacheRoot,
        XDG_CONFIG_HOME: configRoot,
      },
      cleanup(): void {
        for (const d of [stateRoot, cacheRoot, configRoot]) {
          try {
            fs.rmSync(d, { recursive: true, force: true });
          } catch {
            // best-effort
          }
        }
      },
    };
  }

  function isConnectable(sockPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!fs.existsSync(sockPath)) {
        resolve(false);
        return;
      }
      const s = net.connect(sockPath);
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
  }

  async function waitUntil(
    check: () => Promise<boolean>,
    budgetMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  test("a 3rd real daemon blocks until a slot frees, on a pool sized 2", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 2);
    const fx1 = makeFixture("cc-candybar-poolit-1-");
    const fx2 = makeFixture("cc-candybar-poolit-2-");
    const fx3 = makeFixture("cc-candybar-poolit-3-");

    try {
      // Each spawn's try/finally opens the moment it succeeds, so a later spawn throwing cannot leak an earlier one.
      const d1 = await spawnTestDaemon(fx1.env, pool);
      try {
        const d2 = await spawnTestDaemon(fx2.env, pool);
        try {
          expect(
            await waitUntil(() => isConnectable(fx1.sockPath), 5000),
          ).toBe(true);
          expect(
            await waitUntil(() => isConnectable(fx2.sockPath), 5000),
          ).toBe(true);

          const d3Promise = spawnTestDaemon(fx3.env, pool);
          try {
            try {
              const stillBlocked = !(await waitUntil(
                () => isConnectable(fx3.sockPath),
                800,
              ));
              expect(stillBlocked).toBe(true);
            } finally {
              // Free a slot UNCONDITIONALLY or the outer drain hangs on the ~20s acquire timeout; killTree because the `tsx` wrapper forks the worker holding the socket.
              d1.killTree();
              d1.release();
            }

            const d3 = await d3Promise;
            try {
              expect(
                await waitUntil(() => isConnectable(fx3.sockPath), 5000),
              ).toBe(true);
            } finally {
              d3.killTree();
              d3.release();
            }
          } catch (err) {
            try {
              const d3 = await d3Promise;
              d3.killTree();
              d3.release();
            } catch {
              // already handled internally by spawnTestDaemon
            }
            throw err;
          }
        } finally {
          d2.killTree();
          d2.release();
        }
      } finally {
        d1.killTree();
        d1.release();
      }
    } finally {
      fx1.cleanup();
      fx2.cleanup();
      fx3.cleanup();
    }
  });
});
