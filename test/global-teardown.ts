// [LAW:verifiable-goals] Runs once after the entire `pnpm test` invocation
// (Jest `globalTeardown`, a separate process from every worker). Leaves ZERO
// leftover jest daemon-pool cruft on a clean run — "a leftover
// cc-candybar-jest-* socket dir after a clean run is a test failure, not
// silent debris" (brandon-daemon-lifecycle-gad.1). Never touches a directory
// a live worker still owns, so it's safe to run even while another
// concurrent worktree's suite is mid-run against the SAME shared pool dir —
// the two-worktrees-don't-multiply-the-peak guarantee depends on the pool dir
// itself surviving between runs; only provably-dead entries are removed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDaemonPool,
  DEFAULT_POOL_DIR,
  DEFAULT_POOL_SIZE,
} from "./helpers/daemon-pool";
import { JEST_TMP_PREFIX, jestTmpOwner } from "./helpers/jest-tmp";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import {
  systemProbe,
  type ProcessProbe,
} from "../src/daemon/process-fingerprint";
import { systemLauncher } from "../src/proc/system-launcher";

// [LAW:one-source-of-truth] A directory under this prefix is in use while the
// worker its name carries is alive: another run's daemons and in-worker cases
// write there, a log among them. The sweeper's own pid is the exception. Run in
// band, the worker is this process, whose tests have ended, and in a pool jest
// ends every worker before this runs.
function inUse(
  name: string,
  sweeper: number,
  probe: Pick<ProcessProbe, "alive">,
): boolean {
  const owner = jestTmpOwner(name);
  return owner !== null && owner !== sweeper && probe.alive(owner);
}

// A single readdirSync + in-memory prefix filter, run once per full `pnpm test`
// invocation (not per-file, not per-test): the alternative (a hand-maintained
// cleanup-list file every dir-creating test must remember to append to) trades
// this self-describing scan for a second, independently-maintained source of
// truth that silently drifts the moment one caller forgets to register — worse
// than the scan it would save microseconds against.
export function sweepJestTmp(
  root: string,
  sweeper: number,
  probe: Pick<ProcessProbe, "alive">,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(JEST_TMP_PREFIX)) continue;
    const dir = path.join(root, name);
    if (dir === DEFAULT_POOL_DIR) continue; // the shared pool persists — swept by `sweepStale`, never removed
    if (inUse(name, sweeper, probe)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  const ending = new AbortController();
  const launcher = systemLauncher(
    { inherited: process.env, signal: ending.signal },
    systemTimekeeper,
  );
  try {
    const probe = systemProbe(launcher);
    await createDaemonPool(
      DEFAULT_POOL_DIR,
      DEFAULT_POOL_SIZE,
      probe,
    ).sweepStale();
    sweepJestTmp(os.tmpdir(), process.pid, probe);
  } finally {
    ending.abort();
    const { unreaped } = await launcher.settled();
    if (unreaped.length)
      throw new Error(`Sweep left child processes: ${unreaped.join(", ")}`);
  }
}
