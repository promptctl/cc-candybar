// The suite's isolated daemons: scripts/lib/daemon/isolated.ts's over the
// worker's environment (test/setup.ts isolated it from the developer's), each
// started from the machine-wide daemon pool, so every real daemon a test
// starts counts against the ceiling.
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

export const prepareIsolatedDaemonEnv = (tmpPrefix: string): IsolatedDaemonEnv =>
  prepareOver(tmpPrefix, process.env);

export const spawnDaemonWithEnv = (
  env: NodeJS.ProcessEnv,
  entry?: DaemonEntry,
): Promise<RunningDaemon> => startDaemonWithEnv(env, fromThePool, entry);

export const spawnIsolatedDaemon = (
  tmpPrefix: string,
  entry?: DaemonEntry,
): Promise<IsolatedDaemonHandle> =>
  startIsolatedDaemon(tmpPrefix, process.env, fromThePool, entry);
