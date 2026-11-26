// [LAW:single-enforcer] The test suite's spawner of a real `cc-candybar daemon`
// subprocess. Every call gates on `daemonPool` first, so a daemon started here
// counts against the shared machine-global ceiling — see daemon-pool.ts for why
// that ceiling has to be machine-global, not per-worker or per-worktree.
import {
  SOURCE_ENTRY,
  spawnDaemonProcess,
  type AcquireSlot,
  type DaemonEntry,
  type DaemonProcess,
} from "../../scripts/lib/daemon/process";
import {
  createDaemonPool,
  DEFAULT_POOL_DIR,
  DEFAULT_POOL_SIZE,
  type DaemonPool,
} from "./daemon-pool";
import { processProbe } from "./host";
import { untilTestEnds } from "./test-end";

// The shared, machine-global pool every real-daemon-spawning test file uses,
// read through this worker's own probe.
export const daemonPool: DaemonPool = createDaemonPool(
  DEFAULT_POOL_DIR,
  DEFAULT_POOL_SIZE,
  processProbe,
);

// [LAW:one-source-of-truth] How a daemon the suite starts takes its place
// under the machine's ceiling, waiting until a slot frees or `until` ends.
export const fromThePool =
  (until: AbortSignal): AcquireSlot =>
  () =>
    daemonPool.acquire({ until });

// A daemon's slot is held in the jest worker's name, so while the worker lives
// a daemon that is alive, stopped or not, counts against the machine's
// ceiling; a worker that dies leaves its slots to the stale sweep, which frees
// them whatever became of the daemons.
export function spawnTestDaemon(
  env: NodeJS.ProcessEnv,
  // Overridable only so tests can pin the ceiling under test to a small,
  // isolated pool (see daemon-pool.test.ts) — every real spawn site in the
  // suite itself uses the default, shared, machine-global pool.
  pool: DaemonPool = daemonPool,
  entry: DaemonEntry = SOURCE_ENTRY,
): Promise<DaemonProcess> {
  return untilTestEnds((ended) =>
    spawnDaemonProcess(env, () => pool.acquire({ until: ended }), entry),
  );
}
