import {
  open as fsOpen,
  readdir as fsReaddir,
  readFile as fsReadFile,
  stat as fsStat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { statSync } from "node:fs";

import { ABSENT, failed, ok, type Outcome } from "./outcome";
import { debug } from "./logger";

// [LAW:single-enforcer] The one per-render freshness probe: a SYNC single-file
// stat's mtimeMs (0 when the file is absent or unreadable). Sync by design — the
// mtime gate must resolve before deciding whether to read, and a sync stat
// consumes no gate slot (the async `readAppended`/`readFile` bulk reads are what
// the limiter bounds). Both the usage store and the metrics provider key their
// incremental fold off this one helper so the ENOENT→0 policy lives in one place.
export function statMtimeMs(filePath: string | undefined): number {
  if (!filePath) return 0;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

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

// [LAW:single-enforcer] A bounded tail read through the SAME gate: the last
// `maxBytes` of a file (the whole file when smaller), plus whether that window
// reaches the file start. The open→stat→read→close runs under one gate slot, so
// a tail read counts as one in-flight op exactly like a readFile — a transcript
// scanner that grows its window backward must use THIS, not raw node:fs, or it
// reintroduces the unbounded-fs state the gate forbids.
//
// [LAW:no-silent-failure] The file not existing is the expected, every-render
// case for a fresh session (no transcript yet) — `absent`. Any other error
// (permissions, I/O) is a real read failure — `failed`, carrying its reason
// to whichever boundary owns the log effect. Folding both into one null made
// a broken transcript indistinguishable from a missing one.
// [LAW:single-enforcer] The forward complement of readTail, through the SAME
// gate: read the bytes of an append-only file from `priorOffset` to EOF (the
// whole file when `priorOffset` is undefined). One open→stat→read→close per
// gate slot, exactly like readTail. A transcript scanner that maintains a byte
// cursor to re-read only what was appended MUST use this, not raw node:fs, or it
// reintroduces the unbounded-fs state the gate forbids.
//
// [LAW:one-source-of-truth] `reset` is the single signal that the file shrank
// below the caller's cursor — a truncation or /compact rewrite — so the caller
// discards its prior fold for this file and re-folds from the returned bytes
// (which then start at offset 0). Append-only monotonicity makes every other
// case a pure suffix read: `start..size` is exactly what's new.
//
// [LAW:no-silent-failure] ENOENT (fresh session, no transcript yet) is `absent`;
// any other error is `failed`, carrying its reason to the boundary that logs.
export async function readAppended(
  path: string,
  prior: { offset: number; ino: number } | undefined,
): Promise<
  Outcome<{
    buf: Buffer;
    start: number;
    size: number;
    mtimeMs: number;
    ino: number;
    reset: boolean;
  }>
> {
  return gate.run(async () => {
    let fh: FileHandle | null = null;
    try {
      fh = await fsOpen(path, "r");
      const { size, mtimeMs, ino } = await fh.stat();
      // [LAW:one-source-of-truth] The prior fold is a valid PREFIX of this file
      // only while the file stays append-only. Two independent signals break
      // that: the inode changed (a rename-based /compact or log rotation swapped
      // the file under the path — the realistic rewrite mechanism), or the file
      // shrank below our cursor (an in-place truncate). Either ⇒ re-read from 0;
      // the suffix-only read would otherwise splice new bytes onto a fold of a
      // file that no longer exists. (A cursor-only size check missed a rewrite
      // that grew back to ≥ the cursor.)
      const reset =
        prior !== undefined && (ino !== prior.ino || size < prior.offset);
      const start = reset || prior === undefined ? 0 : prior.offset;
      if (start >= size) {
        return ok({ buf: Buffer.alloc(0), start, size, mtimeMs, ino, reset });
      }
      const buf = Buffer.alloc(size - start);
      // [LAW:no-silent-fallbacks] A single read may return short — parsing a
      // zero-padded tail would fabricate entries. Loop until the window fills or
      // EOF; on a short final read (the file shrank under us) return only the
      // bytes actually read, never the zero padding.
      let off = 0;
      while (off < buf.length) {
        const { bytesRead } = await fh.read(
          buf,
          off,
          buf.length - off,
          start + off,
        );
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return ok({
        buf: off === buf.length ? buf : buf.subarray(0, off),
        start,
        size,
        mtimeMs,
        ino,
        reset,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
      return failed(
        `readAppended ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      // [LAW:no-silent-failure] A close() rejection must NOT override the typed
      // Outcome the try returned — callers await this and read `.kind`, so a raw
      // rejection would escape every failed-guard. A failed close after a good
      // read doesn't invalidate the read, but it can signal a real fs problem
      // (ENOSPC on fsync), so log it at debug rather than swallowing it blind.
      await fh?.close().catch((e: unknown) => {
        debug(
          `transcript-fs: close failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
  });
}

export async function readTail(
  path: string,
  maxBytes: number,
): Promise<Outcome<{ buf: Buffer; fromStart: boolean }>> {
  return gate.run(async () => {
    let fh: FileHandle | null = null;
    try {
      fh = await fsOpen(path, "r");
      const { size } = await fh.stat();
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      // [LAW:no-silent-fallbacks] A single read may return short — the scanner
      // would then parse a zero-padded tail and miss cache activity. Loop until
      // the window is filled or EOF; on a short final read (the file shrank
      // under us) return only the bytes actually read, never the zero padding.
      let off = 0;
      while (off < buf.length) {
        const { bytesRead } = await fh.read(
          buf,
          off,
          buf.length - off,
          start + off,
        );
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return ok({
        buf: off === buf.length ? buf : buf.subarray(0, off),
        fromStart: start === 0,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
      return failed(
        `readTail ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      // [LAW:no-silent-failure] A close() rejection must NOT override the typed
      // Outcome the try returned — callers await this and read `.kind`, so a raw
      // rejection would escape every failed-guard. A failed close after a good
      // read doesn't invalidate the read, but it can signal a real fs problem
      // (ENOSPC on fsync), so log it at debug rather than swallowing it blind.
      await fh?.close().catch((e: unknown) => {
        debug(
          `transcript-fs: close failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
  });
}
