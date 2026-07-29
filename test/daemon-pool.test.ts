import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createDaemonPool } from "./helpers/daemon-pool";
import { spawnTestDaemon } from "./helpers/spawn-test-daemon";

// [LAW:verifiable-goals] Pins the shared-pool primitive's core contract in
// isolation — no real cc-candybar daemon spawns, so this stays fast — mirroring
// the arbitrateSocket pure-fold test style: full input-space coverage of the
// mechanism the fork-bomb epic (brandon-daemon-lifecycle-gad.1) needs to hold.

// [LAW:single-enforcer] Every `tmpPoolDir()` call in this file is tracked
// here and swept once in the file-level `afterAll` — the one cleanup site,
// so no individual test needs its own dir-removal boilerplate.
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
    // Both live (this process's own pid), so the pool is genuinely full — a
    // third acquire must not proceed until one is released.
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
    // Give the pending acquire a moment to actually be polling before we free
    // the slot, so this exercises the retry path rather than a lucky win.
    await new Promise((r) => setTimeout(r, 100));
    a.release();
    const b = await pending;
    b.release();
  });

  // [LAW:behavior-not-structure] The reclaim path is what stops a single
  // crashed test daemon from permanently consuming a slot. Uses a REAL dead
  // pid (spawned, killed, awaited) rather than a fabricated number — a
  // fabricated pid risks colliding with a live unrelated process on the host,
  // which would make this test non-deterministic.
  test("reclaims a slot whose recorded owner is dead", async () => {
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    const deadPid = dead.pid!;

    const pool = createDaemonPool(tmpPoolDir(), 1);
    // Plant a stale slot file directly, as if a prior (now-dead) process held it.
    fs.mkdirSync(pool.dir, { recursive: true });
    fs.writeFileSync(
      path.join(pool.dir, "slot-0.json"),
      JSON.stringify({ pid: deadPid, startTime: null }),
    );

    const slot = await pool.acquire({ timeoutMs: 2000, retryIntervalMs: 50 });
    slot.release();
  });

  test("release is a no-op if the slot was already reclaimed by someone else", async () => {
    const pool = createDaemonPool(tmpPoolDir(), 1);
    const a = await pool.acquire();
    // Simulate another process reclaiming this slot after we lost ownership
    // some other way (e.g. a sweep) — release() must not blow away the new
    // owner's record.
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

// [LAW:verifiable-goals] End-to-end proof of the epic's own acceptance
// criterion ("Full `pnpm test` peaks at ≤ the chosen ceiling of live
// daemons — assert via a probe") against REAL cc-candybar daemon
// subprocesses, not fake stand-ins. Pinned to an isolated size-2 pool (not
// the shared default) so this test is fast and never contends with the rest
// of the suite's real spawns.
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
      // Each spawn's own try/finally starts immediately after it succeeds —
      // not after all three have been kicked off — so a later spawn (d2, d3)
      // throwing can never leak an earlier one (d1) that already succeeded.
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

          // Pool is full (2/2). The 3rd spawn must not even start its daemon
          // process until a slot frees — that's the ceiling this pool exists
          // to enforce. spawnTestDaemon(..., { timeoutMs: 15000 }) isn't an
          // option (the signature doesn't expose it), so race the acquire
          // itself against a short "still blocked" probe.
          const d3Promise = spawnTestDaemon(fx3.env, pool);
          const stillBlocked = !(await waitUntil(
            () => isConnectable(fx3.sockPath),
            800,
          ));
          expect(stillBlocked).toBe(true);

          // Free one slot — the 3rd daemon must now come up. killTree (not
          // child.kill) — the `tsx` wrapper forks its own worker that holds
          // the real socket, which survives as an orphan if only the
          // wrapper dies.
          d1.killTree();
          d1.release();

          const d3 = await d3Promise;
          try {
            expect(
              await waitUntil(() => isConnectable(fx3.sockPath), 5000),
            ).toBe(true);
          } finally {
            d3.killTree();
            d3.release();
          }
        } finally {
          d2.killTree();
          d2.release();
        }
      } finally {
        // Idempotent — a no-op if the pool-full branch above already freed
        // d1 (release() is guarded; killTree tolerates an already-dead group).
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
