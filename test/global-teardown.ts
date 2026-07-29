// [LAW:verifiable-goals] Runs once after the entire `pnpm test` invocation
// (Jest `globalTeardown`, a separate process from every worker). Leaves ZERO
// leftover jest daemon-pool cruft on a clean run — "a leftover
// cc-candybar-jest-* socket dir after a clean run is a test failure, not
// silent debris" (brandon-daemon-lifecycle-gad.1). Never touches a directory
// a live process still holds, so it's safe to run even while another
// concurrent worktree's suite is mid-run against the SAME shared pool dir —
// the two-worktrees-don't-multiply-the-peak guarantee depends on the pool dir
// itself surviving between runs; only provably-dead entries are removed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_POOL_DIR, daemonPool } from "./helpers/daemon-pool";
import { readLease } from "../src/daemon/socket-lease";
import { leasePathFor } from "../src/daemon/paths";
import { readStartTime, sameLiveProcess } from "../src/daemon/process-fingerprint";
import { pidAlive } from "../src/daemon/parent-watchdog";

const JEST_TMP_PREFIX = "cc-candybar-jest-";

// [LAW:one-source-of-truth] Liveness for a dir under this prefix is decided
// the SAME way the daemon itself decides socket ownership — the (pid,
// start-time) lease, never a raw connect() probe. A connect probe is the
// exact false-dead trap `src/daemon/socket-lease.ts` exists to close: a live
// daemon whose accept backlog is briefly full returns ECONNREFUSED,
// indistinguishable from dead, which would delete a live daemon's tmpdir out
// from under it.
function isLive(dir: string): boolean {
  const lease = readLease(leasePathFor(path.join(dir, "socket")));
  if (lease.kind !== "owned") return false;
  return sameLiveProcess(lease.pid, lease.startTime, {
    readStartTime,
    pidAlive,
  });
}

export default function globalTeardown(): void {
  // The shared pool's own bookkeeping: drop slot files whose recorded owner
  // is provably dead.
  daemonPool.sweepStale();

  // Generic sweep for any `cc-candybar-jest-*` tmpdir entry — covers
  // `test/setup.ts`'s per-file CC_CANDYBAR_SOCKET assignment, dormant today
  // (every real-daemon-spawning test file overrides it with its own tmp
  // path) but the exact shape the parent epic's storm mechanism describes.
  // A single readdirSync + in-memory prefix filter, run once per full
  // `pnpm test` invocation (not per-file, not per-test): the alternative
  // (a hand-maintained cleanup-list file every dir-creating test must
  // remember to append to) trades this self-describing scan for a second,
  // independently-maintained source of truth that silently drifts the
  // moment one caller forgets to register — worse than the scan it would
  // save microseconds against.
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(JEST_TMP_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    if (dir === DEFAULT_POOL_DIR) continue; // the shared pool persists — swept above, never removed
    if (isLive(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
