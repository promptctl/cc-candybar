// [LAW:single-enforcer] The one machine-global ceiling on concurrent REAL daemon
// subprocesses: per-file sockets give isolation, not a count bound, since
// daemons on different sockets cannot arbitrate each other away.
// [FRAMING:representation][LAW:one-source-of-truth] A slot's owner is the same
// `ProcessIdentity` the socket lease composes from; `LeaseRecord` is not reused.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  readStartTime,
  readOwnStartTime,
  sameLiveProcess,
  type ProcessIdentity,
} from "../../src/daemon/process-fingerprint";
import { pidAlive } from "../../src/daemon/parent-watchdog";

type SlotRecord = ProcessIdentity;

export interface DaemonSlot {
  release(): void;
}

export interface AcquireOpts {
  timeoutMs?: number;
  retryIntervalMs?: number;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_INTERVAL_MS = 200;

export interface DaemonPool {
  readonly dir: string;
  readonly size: number;
  acquire(opts?: AcquireOpts): Promise<DaemonSlot>;
  // Removes slots dead AT THE TIME OF THE CHECK; never one live when checked.
  sweepStale(): void;
}

function readSlot(p: string): SlotRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SlotRecord> | null;
    const pid = parsed?.pid;
    // [LAW:one-source-of-truth] `kill(0, 0)` signals the CALLER's own group, so
    // `pid: 0` must never read as an identity — as readLease also checks.
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    return {
      pid,
      startTime: typeof parsed?.startTime === "string" ? parsed.startTime : null,
    };
  } catch {
    return null;
  }
}

function isSlotLive(record: SlotRecord): boolean {
  return sameLiveProcess(record.pid, record.startTime, {
    readStartTime,
    pidAlive,
  });
}

export function createDaemonPool(dir: string, size: number): DaemonPool {
  const slotPath = (i: number): string => path.join(dir, `slot-${i}.json`);
  fs.mkdirSync(dir, { recursive: true });

  // Rename-then-read-back is NOT a compare-and-swap: a second racer's later
  // rename can overwrite us, so two callers can briefly hold one slot.
  function tryClaim(i: number, myPid: number, myStartTime: string | null): boolean {
    const p = slotPath(i);
    const payload = JSON.stringify({ pid: myPid, startTime: myStartTime });
    try {
      fs.writeFileSync(p, payload, { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const existing = readSlot(p);
    if (existing !== null && isSlotLive(existing)) return false;
    const tmp = `${p}.${myPid}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, p);
    const after = readSlot(p);
    return after !== null && after.pid === myPid;
  }

  async function acquire(opts: AcquireOpts = {}): Promise<DaemonSlot> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    const retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const myPid = process.pid;
    const myStartTime = readOwnStartTime(myPid);
    const deadline = Date.now() + timeoutMs;
    // [LAW:no-silent-failure] A full pool must fail loudly, never fall back.
    const timeoutError = (): Error =>
      new Error(
        `daemon-pool: no free slot among ${size} within ${timeoutMs}ms ` +
          `(${dir}) — too many concurrent real daemon spawns on this machine`,
      );
    let claimed: number | null = null;
    for (;;) {
      for (let i = 0; i < size; i++) {
        if (tryClaim(i, myPid, myStartTime)) {
          claimed = i;
          break;
        }
        // After EVERY tryClaim: each shells out to `ps` with a 2000ms timeout.
        if (Date.now() >= deadline) throw timeoutError();
      }
      if (claimed !== null) break;
      if (Date.now() >= deadline) throw timeoutError();
      await new Promise((r) => setTimeout(r, retryIntervalMs));
    }
    const slotIndex = claimed;
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        const p = slotPath(slotIndex);
        const existing = readSlot(p);
        if (existing !== null && existing.pid === myPid) {
          try {
            fs.unlinkSync(p);
          } catch {
            // best-effort
          }
        }
      },
    };
  }

  function sweepStale(): void {
    if (!fs.existsSync(dir)) return;
    for (let i = 0; i < size; i++) {
      const p = slotPath(i);
      const existing = readSlot(p);
      if (existing !== null && !isSlotLive(existing)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // best-effort
        }
      }
    }
  }

  return { dir, size, acquire, sweepStale };
}

// A fixed path is the point: what every concurrent `pnpm test` contends over.
export const DEFAULT_POOL_DIR = path.join(
  os.tmpdir(),
  "cc-candybar-jest-daemon-pool",
);
export const DEFAULT_POOL_SIZE = 4;

export const daemonPool: DaemonPool = createDaemonPool(
  DEFAULT_POOL_DIR,
  DEFAULT_POOL_SIZE,
);
