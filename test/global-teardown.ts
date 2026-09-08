// [LAW:verifiable-goals] Runs once after the whole `pnpm test` invocation. A leftover
// cc-candybar-jest-* dir is a failure, so only provably-dead entries are removed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_POOL_DIR, daemonPool } from "./helpers/daemon-pool";
import { readLease } from "../src/daemon/socket-lease";
import { leasePathFor } from "../src/daemon/paths";
import { readStartTime, sameLiveProcess } from "../src/daemon/process-fingerprint";
import { pidAlive } from "../src/daemon/parent-watchdog";

const JEST_TMP_PREFIX = "cc-candybar-jest-";

// [LAW:one-source-of-truth] Liveness is the daemon's own (pid, start-time) lease, never
// a connect probe: a full accept backlog returns ECONNREFUSED, indistinguishable from dead.
function isLive(dir: string): boolean {
  const lease = readLease(leasePathFor(path.join(dir, "socket")));
  if (lease.kind !== "owned") return false;
  return sameLiveProcess(lease.pid, lease.startTime, {
    readStartTime,
    pidAlive,
  });
}

export default function globalTeardown(): void {
  daemonPool.sweepStale();

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
