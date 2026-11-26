// The suite's isolated daemons: scripts/lib/daemon/isolated.ts's over the
// worker's environment (test/setup.ts isolated it from the developer's), each
// started from the machine-wide daemon pool, so every real daemon a test
// starts counts against the ceiling. A start waits for its slot and its first
// answer until its test ends.
import {
  prepareIsolatedDaemonEnv as prepareOver,
  startDaemonWithEnv,
  startIsolatedDaemon,
  type IsolatedDaemonEnv,
  type IsolatedDaemonHandle,
  type RunningDaemon,
} from "../../scripts/lib/daemon/isolated";
import type { DaemonEntry } from "../../scripts/lib/daemon/process";
import { fromThePool } from "./spawn-test-daemon";
import { untilTestEnds } from "./test-end";

export const prepareIsolatedDaemonEnv = (
  tmpPrefix: string,
): IsolatedDaemonEnv => prepareOver(tmpPrefix, process.env);

export const spawnDaemonWithEnv = (
  env: NodeJS.ProcessEnv,
  entry?: DaemonEntry,
): Promise<RunningDaemon> =>
  untilTestEnds(
    (ended) => startDaemonWithEnv(env, fromThePool(ended), ended, entry),
    "the isolated daemon to start",
  );

export const spawnIsolatedDaemon = (
  tmpPrefix: string,
  entry?: DaemonEntry,
): Promise<IsolatedDaemonHandle> =>
  untilTestEnds(
    (ended) =>
      startIsolatedDaemon(
        tmpPrefix,
        process.env,
        fromThePool(ended),
        ended,
        entry,
      ),
    "the isolated daemon to start",
  );
