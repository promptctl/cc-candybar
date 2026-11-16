import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDaemonPool } from "../../helpers/daemon-pool";
import { isConnectable } from "../../helpers/daemon-wire";
import { spawnTestDaemon } from "../../helpers/spawn-test-daemon";
import { until } from "../../helpers/until";

// [LAW:verifiable-goals] Integration proof for the daemon-side fork-bomb
// circuit breaker (brandon-daemon-lifecycle-gad.2): with a real, tiny ceiling
// and a real registry directory on disk, the (ceiling+1)th isolated daemon
// must refuse to boot — exiting with failure, never binding its own socket —
// and a dead sibling's stale registry entry must not permanently
// occupy a ceiling slot. The pure decision logic (decideBoot/countLiveEntries/
// admitDaemon) is exhaustively unit-tested in fork-bomb-breaker.test.ts; this
// file is the wiring proof and doubles as the CI regression gate the ticket's
// acceptance asks for ("a regression that lets the count run away fails CI").

const CEILING = 2;
// [LAW:verifiable-goals] How long any one step may take before the test
// calls it hung, by name. It claims nothing about speed: every step here
// boots Node or waits on one, and how long that takes measures the machine's
// load, not the breaker. A rejected wait still runs the test's cleanup.
const HUNG_MS = 20_000;

// A dedicated pool (not the suite's shared default) and a dedicated registry
// dir (not the machine's real shared one, see daemonRegistryDir()'s
// CC_CANDYBAR_DAEMON_REGISTRY_DIR override) so this test is fast, isolated,
// and never contends with — or pollutes — anything else running concurrently.
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
  // [LAW:single-enforcer] Socket parent must satisfy ensureSocketParentSafe
  // (uid==me + mode 0700); pre-creating with default umask perms would trip
  // the daemon's bind-time refusal.
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

const ended = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

describe("daemon-side fork-bomb circuit breaker (integration)", () => {
  // Five named steps, each bounded by HUNG_MS, so the test's own timeout
  // never fires before one of them has said which hung.
  jest.setTimeout(6 * HUNG_MS);

  test("refuses the (ceiling+1)th isolated daemon; a dead sibling's slot is reclaimed", async () => {
    const pool = createDaemonPool(tmpDir("cc-candybar-breaker-pool-"), 4);
    const registryDir = tmpDir("cc-candybar-breaker-registry-");

    const fx1 = makeFixture("cc-candybar-breaker-1-", registryDir);
    const fx2 = makeFixture("cc-candybar-breaker-2-", registryDir);
    const fx3 = makeFixture("cc-candybar-breaker-3-", registryDir);

    // [LAW:single-enforcer] One cleanup list, run in reverse in a single
    // `finally` at the end — no individual spawn needs its own nested
    // try/finally, and a mid-test assertion throw still tears everything
    // down.
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

      await until(() => isConnectable(fx1.sockPath), "d1's socket", HUNG_MS);
      await until(() => isConnectable(fx2.sockPath), "d2's socket", HUNG_MS);

      // Ceiling is full (2/2 live isolated daemons registered). The 3rd must
      // refuse — exiting with failure, never binding its own socket.
      const d3 = await spawnTestDaemon(fx3.env, pool);
      cleanups.push(() => {
        d3.killTree();
        d3.release();
      });
      // [LAW:verifiable-goals] The log message is a diagnostic, not part of
      // the contract this asserts: `dlog`'s write is buffered and
      // `shutdown()`'s `process.exit()` does not wait for it to flush (a
      // pre-existing race shared by every shutdown path, not specific to
      // this breaker), so the file's on-disk content right after exit is not
      // a reliable signal. Exit code + "never bound a socket" are the
      // load-bearing, deterministic proof that the breaker fired.
      await until(() => ended(d3.child), "d3's exit", HUNG_MS);
      expect(d3.child.signalCode).toBeNull();
      expect(d3.child.exitCode).toBe(1);
      expect(fs.existsSync(fx3.sockPath)).toBe(false);

      // Kill one of the two admitted daemons WITHOUT its graceful shutdown
      // path (SIGKILL — the runaway/OOM case this epic fights) so its
      // registry entry is left behind as a stale file: the exact condition
      // admitDaemon()'s sweep exists to reclaim.
      // The wrapper's exit is not the worker's, and the worker's live
      // registry entry is what holds the slot: its socket stops answering
      // once the worker itself is gone.
      d2.killTree();
      await until(
        () => isConnectable(fx2.sockPath).then((up) => !up),
        "d2's worker gone",
        HUNG_MS,
      );

      const fx4 = makeFixture("cc-candybar-breaker-4-", registryDir);
      const d4 = await spawnTestDaemon(fx4.env, pool);
      cleanups.push(() => {
        d4.killTree();
        d4.release();
      });
      // d4 is d3's control: a fixture like it boots once a slot is free, so
      // d3's refusal was the ceiling's.
      await until(() => isConnectable(fx4.sockPath), "d4's socket", HUNG_MS);
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
