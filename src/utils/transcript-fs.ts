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

// A counting semaphore that runs at most `max` thunks concurrently. Slots are
// handed off directly to the next waiter on release (never incremented while a
// waiter is parked), so admission can never exceed `max` — the over-admission
// race of an increment-then-wake design is structurally absent.
class Limiter {
  private slots: number;
  private readonly waiters: Array<() => void> = [];

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
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.slots++;
  }
}

const gate = new Limiter(TRANSCRIPT_FS_CONCURRENCY);

// Wrap an async fs primitive so every call flows through the shared gate while
// preserving the original's full overloaded signature for callers (`as F`).
function gated<F extends (...args: never[]) => Promise<unknown>>(fn: F): F {
  return ((...args: Parameters<F>) =>
    gate.run(() => fn(...args))) as unknown as F;
}

export const readdir = gated(fsReaddir);
export const readFile = gated(fsReadFile);
export const stat = gated(fsStat);
