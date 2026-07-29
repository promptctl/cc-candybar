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
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { DEFAULT_POOL_DIR, daemonPool } from "./helpers/daemon-pool";

const JEST_TMP_PREFIX = "cc-candybar-jest-";
const CONNECT_TIMEOUT_MS = 500;

function isConnectable(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) {
      resolve(false);
      return;
    }
    const sock = net.connect(sockPath);
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), CONNECT_TIMEOUT_MS).unref();
  });
}

export default async function globalTeardown(): Promise<void> {
  // The shared pool's own bookkeeping: drop slot files whose recorded owner
  // is provably dead.
  daemonPool.sweepStale();

  // Generic sweep for any `cc-candybar-jest-*` tmpdir entry — covers
  // `test/setup.ts`'s per-file CC_CANDYBAR_SOCKET assignment, dormant today
  // (every real-daemon-spawning test file overrides it with its own tmp
  // path) but the exact shape the parent epic's storm mechanism describes.
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
    const stillLive = await isConnectable(path.join(dir, "socket"));
    if (stillLive) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
