// [LAW:single-enforcer] The one real-daemon spawn site; every call gates on the pool.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { daemonPool, type DaemonPool } from "./daemon-pool";

const REPO_ROOT = process.cwd();

// The default runs the TS source under tsx; builtBundle() pins the real on-disk layout.
export interface DaemonEntry {
  readonly bin: string;
  readonly args: readonly string[];
}

export const TSX_SOURCE_ENTRY: DaemonEntry = {
  bin: path.join(REPO_ROOT, "node_modules", ".bin", "tsx"),
  args: [path.join(REPO_ROOT, "src", "index.ts")],
};

export const builtBundle = (bundlePath: string): DaemonEntry => ({
  bin: process.execPath,
  args: [bundlePath],
});

export interface TestDaemonProcess {
  child: ChildProcess;
  // [LAW:no-silent-failure] `tsx` forks its worker as a SEPARATE OS process, so `child` is only the wrapper; killTree signals the whole group. Never throws.
  killTree(signal?: NodeJS.Signals): void;
  release(): void;
}

export async function spawnTestDaemon(
  env: NodeJS.ProcessEnv,
  pool: DaemonPool = daemonPool,
  entry: DaemonEntry = TSX_SOURCE_ENTRY,
): Promise<TestDaemonProcess> {
  const slot = await pool.acquire();
  let child: ChildProcess;
  try {
    child = spawn(entry.bin, [...entry.args, "daemon"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // New session + process group, inherited by tsx's worker — what killTree needs.
      detached: true,
    });
  } catch (e) {
    slot.release();
    throw e;
  }
  // Drain stdio so the child's pipes don't fill and stall.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    slot.release();
  };
  // [LAW:no-ambient-temporal-coupling] Release rides the exit event, not caller teardown.
  child.once("exit", releaseOnce);
  // [LAW:no-silent-failure] `spawn()` can fail asynchronously: with no 'error' listener Node crashes the worker, and no 'exit' fires, so the slot wedges.
  child.once("error", releaseOnce);

  // [LAW:no-silent-failure] Best-effort: a throw in teardown would mask the real failure.
  const killTree = (signal: NodeJS.Signals = "SIGKILL"): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // best-effort
    }
  };

  return { child, killTree, release: releaseOnce };
}
