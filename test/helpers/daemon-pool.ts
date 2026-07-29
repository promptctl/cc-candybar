// [LAW:single-enforcer] The one machine-global gate on concurrent REAL
// cc-candybar daemon subprocesses spawned by the test suite. Before this, the
// only per-daemon guard was `test/setup.ts` minting a fresh CC_CANDYBAR_SOCKET
// per test FILE — isolation, not a count bound. Isolated-per-file sockets
// mean daemons on different sockets can never arbitrate each other away (the
// existing single-instance machinery all keys off ONE socket path), so the
// live-daemon count was bounded only by (daemon-spawning test files) ×
// (jest workers) × (concurrent worktree suite runs) — unboundedly, which is
// exactly what produced the 192-daemon storm (epic
// brandon-daemon-lifecycle-gad). This pool adds the missing invariant: a
// fixed, machine-global directory (NOT per-worker, NOT per-worktree) holding
// a small constant number of slots, so every `pnpm test` invocation anywhere
// on the machine contends for the SAME small ceiling regardless of worker
// count or how many worktrees are running suites at once.
//
// [FRAMING:representation] A slot's owner is (pid, kernel start-time) — the
// same process-identity pair `src/daemon/socket-lease.ts` uses for socket
// ownership. Reused here via `process-fingerprint.ts` (general process
// identity, not socket-specific) rather than reusing `socket-lease.ts`
// itself: a pool slot and a socket lease are different concepts that happen
// to share one liveness primitive, not the same concept — forcing them
// through one type would be the "wrong abstraction stretched over a shape it
// wasn't designed for" the carrying-cost law warns against.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  readStartTime,
  readOwnStartTime,
  sameLiveProcess,
} from "../../src/daemon/process-fingerprint";
import { pidAlive } from "../../src/daemon/parent-watchdog";

interface SlotRecord {
  pid: number;
  startTime: string | null;
}

export interface DaemonSlot {
  // Idempotent. Removes the slot file only if it still names us — a slot we
  // lost a reclaim race for (see tryClaim) must never be deleted out from
  // under its new, legitimate owner.
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
  // Removes every slot whose recorded owner is provably dead. Never removes a
  // slot with a live owner — safe to call even while another concurrent
  // worktree's suite is mid-run against this same shared pool.
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
    if (typeof parsed?.pid !== "number") return null;
    return {
      pid: parsed.pid,
      startTime: typeof parsed.startTime === "string" ? parsed.startTime : null,
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

  // Attempt to claim slot `i` for (myPid, myStartTime). A genuinely free slot
  // is won by an atomic exclusive create — the OS admits exactly one winner.
  // A stale slot (dead or unreadable owner) is reclaimed by an atomic
  // write-tmp+rename publish, THEN read back to confirm we're still the
  // named owner: two racing reclaimers can both "succeed" at the write, but
  // only the one whose write landed last survives the read-back, so the loser
  // correctly reports failure instead of believing it holds a slot it lost.
  function tryClaim(i: number, myPid: number, myStartTime: string | null): boolean {
    const p = slotPath(i);
    const payload = JSON.stringify({ pid: myPid, startTime: myStartTime });
    fs.mkdirSync(dir, { recursive: true });
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
    let claimed: number | null = null;
    for (;;) {
      for (let i = 0; i < size; i++) {
        if (tryClaim(i, myPid, myStartTime)) {
          claimed = i;
          break;
        }
      }
      if (claimed !== null) break;
      // [LAW:no-silent-failure] Never spawn past the ceiling by falling back
      // silently — a full pool means the test MUST fail loudly so the
      // regression (more concurrent real daemons than the asserted ceiling)
      // is visible instead of quietly re-opening the storm.
      if (Date.now() >= deadline) {
        throw new Error(
          `daemon-pool: no free slot among ${size} within ${timeoutMs}ms ` +
            `(${dir}) — too many concurrent real daemon spawns on this machine`,
        );
      }
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

// The shared, machine-global pool every real-daemon-spawning test file uses.
// Fixed path (not derived from a per-worker or per-worktree value) is the
// whole point: it is the one thing every concurrent `pnpm test` invocation on
// this machine contends over.
export const DEFAULT_POOL_DIR = path.join(
  os.tmpdir(),
  "cc-candybar-jest-daemon-pool",
);
export const DEFAULT_POOL_SIZE = 4;

export const daemonPool: DaemonPool = createDaemonPool(
  DEFAULT_POOL_DIR,
  DEFAULT_POOL_SIZE,
);
