import {
  readdir as fsReaddir,
  readFile as fsReadFile,
  stat as fsStat,
} from "node:fs/promises";

// [LAW:single-enforcer] One owner of the transcript-scanning in-flight-I/O
// budget. Every readdir/stat/readFile over the ~/.claude/projects tree passes
// through this module's limiter, so the number of concurrent libuv fs requests
// is bounded by a constant no matter how many renders fan out at once. The OOM
// heap proved the illegal state this forbids: ~3046 FSReqPromise pending at
// once, each pinning a parked await-stack.
//
// [LAW:types-are-the-program] The bound is enforced by ROUTING, not by a
// post-hoc guard: the transcript path imports these gated primitives instead of
// node:fs/promises, so "thousands of stats/reads in flight" is unrepresentable
// rather than merely checked. There is no `if (tooMany)` anywhere — the same
// fan-out runs every render; the limiter only decides *when* each op dispatches.

// 8 = 2× the libuv default UV_THREADPOOL_SIZE (4). Two dispatched ops per worker
// keeps every threadpool thread fed without a queue-drain stall between syscalls,
// while peak in-flight memory stays O(threadpool) rather than O(transcript count).
const TRANSCRIPT_FS_CONCURRENCY = 8;

interface Waiter {
  readonly wake: () => void;
  next: Waiter | null;
}

// A counting semaphore that runs at most `max` thunks concurrently. Slots are
// handed off directly to the next waiter on release (never incremented while a
// waiter is parked), so admission can never exceed `max` — the over-admission
// race of an increment-then-wake design is structurally absent.
class Limiter {
  private slots: number;
  // FIFO wait queue as a singly-linked list: enqueue at `tail`, dequeue at
  // `head`, both O(1) with no array reindexing (Array.shift would be O(n), so a
  // drain of the thousands-of-queued-ops burst this limiter exists to absorb
  // would be O(n²) on the render hot path). A dequeued node is immediately
  // unreferenced, so a continuously-saturated queue retains only the waiters
  // currently parked — no consumed-prefix accumulates, unlike a head-index
  // array that only reclaims on full drain.
  private head: Waiter | null = null;
  private tail: Waiter | null = null;

  constructor(max: number) {
    this.slots = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    // No slot free — park until release() hands one to us. The slot is
    // transferred directly, so we must NOT decrement again on resume.
    await new Promise<void>((wake) => {
      const node: Waiter = { wake, next: null };
      if (this.tail) this.tail.next = node;
      else this.head = node;
      this.tail = node;
    });
  }

  private release(): void {
    const node = this.head;
    if (!node) {
      // No one waiting — return the slot to the pool.
      this.slots++;
      return;
    }
    // Hand the slot directly to the next waiter; the dequeued node is dropped.
    this.head = node.next;
    if (!this.head) this.tail = null;
    node.wake();
  }
}

const gate = new Limiter(TRANSCRIPT_FS_CONCURRENCY);

// Wrap an async fs primitive so every call flows through the shared gate. The
// `(...args: never[])` bound is the maximally-permissive function constraint
// (parameters are contravariant, so `never[]` accepts any arg list) — it admits
// every fs/promises overload, not rejects them. Callers see the original
// overloaded type `F`; the cast is needed because TS can't prove a generic
// wrapper preserves an overload set, but each fs overload is a valid `fn(...)`
// call, so the wrap is sound (verified: `tsc --noEmit` passes against the
// multi-overload call sites in claude.ts/cache.ts).
function gated<F extends (...args: never[]) => Promise<unknown>>(fn: F): F {
  return ((...args: Parameters<F>) =>
    gate.run(() => fn(...args))) as unknown as F;
}

export const readdir = gated(fsReaddir);
export const readFile = gated(fsReadFile);
export const stat = gated(fsStat);
