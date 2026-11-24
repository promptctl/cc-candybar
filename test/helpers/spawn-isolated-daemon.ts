// The suite's isolated daemons: scripts/lib/daemon/isolated.ts's, each admitted
// through the machine-wide daemon pool, so every real daemon a test starts
// counts against the ceiling.
import {
  startDaemonWithEnv,
  startIsolatedDaemon,
  type IsolatedDaemonHandle,
  type RunningDaemon,
} from "../../scripts/lib/daemon/isolated";
import type { DaemonEntry } from "../../scripts/lib/daemon/process";
import { daemonPool } from "./spawn-test-daemon";

const pooled = () => daemonPool.acquire();

export const spawnDaemonWithEnv = (
  env: NodeJS.ProcessEnv,
  entry?: DaemonEntry,
): Promise<RunningDaemon> => startDaemonWithEnv(env, pooled, entry);

export const spawnIsolatedDaemon = (
  tmpPrefix: string,
  entry?: DaemonEntry,
): Promise<IsolatedDaemonHandle> => startIsolatedDaemon(tmpPrefix, pooled, entry);
