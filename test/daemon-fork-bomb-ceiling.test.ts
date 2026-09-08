import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createDaemonPool } from "./helpers/daemon-pool";
import { spawnTestDaemon } from "./helpers/spawn-test-daemon";

// [LAW:verifiable-goals] Wiring proof; the decision logic is unit-tested separately.

const CEILING = 2;
const REFUSE_BUDGET_MS = 5000;

const createdDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  createdDirs.length = 0;
});

interface Fixture {
  sockPath: string;
  env: NodeJS.ProcessEnv;
}

function makeFixture(prefix: string, registryDir: string): Fixture {
  const stateRoot = tmpDir(prefix);
  const cacheRoot = tmpDir(`${prefix}c-`);
  const configRoot = tmpDir(`${prefix}g-`);
  const stateDir = path.join(stateRoot, "cc-candybar");
  // [LAW:single-enforcer] Socket parent must satisfy ensureSocketParentSafe (uid + 0700).
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
      CC_CANDYBAR_DAEMON_REGISTRY_DIR: registryDir,
      CC_CANDYBAR_DAEMON_CEILING: String(CEILING),
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
  check: () => Promise<boolean> | boolean,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Promise.race does not cancel the losing branch, so the timer is cleared here.
function waitForExit(
  child: ChildProcess,
  budgetMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${budgetMs}ms`));
    }, budgetMs);
    if (child.exitCode !== null || child.signalCode !== null) {
      clearTimeout(timer);
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("daemon-side fork-bomb circuit breaker (integration)", () => {
  jest.setTimeout(30_000);

  test("refuses the (ceiling+1)th isolated daemon; a dead sibling's slot is reclaimed", async () => {
    const pool = createDaemonPool(tmpDir("cc-candybar-breaker-pool-"), 4);
    const registryDir = tmpDir("cc-candybar-breaker-registry-");

    const fx1 = makeFixture("cc-candybar-breaker-1-", registryDir);
    const fx2 = makeFixture("cc-candybar-breaker-2-", registryDir);
    const fx3 = makeFixture("cc-candybar-breaker-3-", registryDir);

    const cleanups: Array<() => void> = [];
    try {
      const d1 = await spawnTestDaemon(fx1.env, pool);
      cleanups.push(() => {
        d1.killTree();
        d1.release();
      });
      const d2 = await spawnTestDaemon(fx2.env, pool);
      cleanups.push(() => {
        d2.killTree();
        d2.release();
      });

      expect(await waitUntil(() => isConnectable(fx1.sockPath), 5000)).toBe(
        true,
      );
      expect(await waitUntil(() => isConnectable(fx2.sockPath), 5000)).toBe(
        true,
      );

      const d3 = await spawnTestDaemon(fx3.env, pool);
      cleanups.push(() => {
        d3.killTree();
        d3.release();
      });
      // [LAW:verifiable-goals] `process.exit()` does not flush `dlog`, so the exit code is the proof.
      const { code, signal } = await waitForExit(d3.child, REFUSE_BUDGET_MS);
      expect(signal).toBeNull();
      expect(code).toBe(1);
      expect(fs.existsSync(fx3.sockPath)).toBe(false);

      // SIGKILL leaves the registry entry behind — what admitDaemon's sweep reclaims.
      d2.killTree();
      await waitForExit(d2.child, 5000);

      const fx4 = makeFixture("cc-candybar-breaker-4-", registryDir);
      const d4 = await spawnTestDaemon(fx4.env, pool);
      cleanups.push(() => {
        d4.killTree();
        d4.release();
      });
      expect(await waitUntil(() => isConnectable(fx4.sockPath), 5000)).toBe(
        true,
      );
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          // best-effort
        }
      }
    }
  });
});
