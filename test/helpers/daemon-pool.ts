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
// [FRAMING:representation] A slot's owner is a `ProcessIdentity` (pid, kernel
// start-time) — the SAME type `src/daemon/socket-lease.ts` composes its
// `LeaseRecord`/`LeaseRead.owned` from, imported from `process-fingerprint.ts`
// (the module that owns the process-identity concept) so the two can never
// drift on that shape [LAW:one-source-of-truth]. What's still NOT reused is
// `LeaseRecord` itself (`version`/`binPath` are socket-lease diagnostics with
// no meaning for a pool slot) or `socket-lease.ts`'s lease-file functions — a
// pool slot and a socket lease are different concepts that happen to share
// one identity shape and one liveness primitive, not the same concept;
// forcing them through one type would be the "wrong abstraction stretched
// over a shape it wasn't designed for" the carrying-cost law warns against.

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
  // Idempotent. Removes the slot file only if it still named us AT THE TIME
  // OF THE CHECK — same residual TOCTOU as tryClaim's reclaim (see its
  // comment for the full rationale): a concurrent reclaimer's rename can
  // land between our read and our unlink, in which case we delete their
  // fresh record instead of our own stale one. Accepted for the same
  // reason: test-only tooling, self-correcting (the next acquire's `wx`
  // create just wins the now-empty slot), not a correctness hazard.
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
  // Removes every slot whose recorded owner is dead AT THE TIME OF THE
  // CHECK. Same residual TOCTOU as tryClaim/release (see tryClaim's
  // comment): a concurrent worktree's reclaim can land between the
  // liveness check and the unlink, deleting their just-claimed live
  // record instead of the dead one we checked. Safe to call during a
  // concurrent worktree's run in the sense that matters — it never touches
  // a slot that was already live when checked, and the rare race
  // self-corrects on the next acquire.
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
    // [LAW:one-source-of-truth] Mirrors readLease's pid validation
    // (socket-lease.ts) — a bare `typeof === "number"` accepts 0, negatives,
    // and non-integers; `process.kill(0, 0)` signals the CALLER's own
    // process group, not a specific owner, so a corrupted `pid: 0` slot
    // must never be treated as a readable identity.
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
  // Once per pool, not once per tryClaim: acquire's retry loop can call
  // tryClaim up to `size` times per poll tick over a ~20s budget — hundreds
  // of calls — and mkdirSync(..., {recursive:true}) is a no-op once the dir
  // exists, so repeating it per call was pure waste.
  fs.mkdirSync(dir, { recursive: true });

  // Attempt to claim slot `i` for (myPid, myStartTime). A genuinely free slot
  // is won by an atomic exclusive create — the OS admits exactly one winner.
  // A stale slot (dead or unreadable owner) is reclaimed by an atomic
  // write-tmp+rename publish, THEN read back to confirm we're still the
  // named owner. This resolves the common case — a racing reclaimer's rename
  // lands before our own read-back, so we correctly see their pid and report
  // failure — but it is NOT a true compare-and-swap: if our read-back lands
  // BEFORE a second racer's rename, we still report success, and that racer's
  // later rename can silently overwrite us, leaving both callers believing
  // they hold the same slot. A real fix needs a cross-process mutex (e.g. an
  // O_EXCL lock dir); skipped here as disproportionate to the blast radius —
  // this is test-only tooling guarding against a daemon storm, and the
  // failure mode is a brief 1-slot overcapacity that self-corrects on the
  // next release, not a correctness hazard.
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
    // [LAW:no-silent-failure] Never spawn past the ceiling by falling back
    // silently — a full pool means the caller MUST fail loudly so the
    // regression (more concurrent real daemons than the asserted ceiling)
    // is visible instead of quietly re-opening the storm.
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
        // Checked after EVERY tryClaim, not just once per full pass: each
        // call shells out to `ps` (isSlotLive's liveness check) with its own
        // 2000ms subprocess timeout, so a size-N pool's single pass could
        // otherwise block up to N×2000ms before the deadline is even
        // consulted — turning a caller's 300ms budget into seconds.
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
