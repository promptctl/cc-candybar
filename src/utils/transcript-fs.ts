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

// [LAW:single-enforcer] The one ENOENT→0 probe; sync, and it takes no gate slot.
export function statMtimeMs(filePath: string | undefined): number {
  if (!filePath) return 0;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

// [LAW:single-enforcer] One owner of the transcript-scanning in-flight-I/O budget.
// [LAW:types-are-the-program] Enforced by ROUTING — callers import these gated
// primitives, not node:fs/promises — so an unbounded fan-out is unrepresentable.

// 2× the libuv default UV_THREADPOOL_SIZE: every thread fed, memory O(threadpool).
const TRANSCRIPT_FS_CONCURRENCY = 8;

interface Waiter {
  readonly wake: () => void;
  next: Waiter | null;
}

// A slot is handed straight to the next waiter, never incremented while one parks.
class Limiter {
  private slots: number;
  // A linked list: O(1) both ends, and a saturated queue retains only live waiters.
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
    // The slot is transferred directly, so do NOT decrement again on resume.
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
      this.slots++;
      return;
    }
    this.head = node.next;
    if (!this.head) this.tail = null;
    node.wake();
  }
}

const gate = new Limiter(TRANSCRIPT_FS_CONCURRENCY);

// `never[]` is the maximally-permissive bound: it admits every fs overload.
function gated<F extends (...args: never[]) => Promise<unknown>>(fn: F): F {
  return ((...args: Parameters<F>) =>
    gate.run(() => fn(...args))) as unknown as F;
}

export const readdir = gated(fsReaddir);
export const readFile = gated(fsReadFile);
export const stat = gated(fsStat);

// [LAW:single-enforcer] One open→stat→read→close per gate slot; a cursor-keeping
// scanner MUST come through here, not raw node:fs.
// [LAW:one-source-of-truth] `reset` is the one signal to re-fold from offset 0.
// [LAW:no-silent-failure] A missing transcript is `absent`, a broken one `failed`.
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
      // [LAW:one-source-of-truth] A changed inode OR a shrink: size alone misses a
      // rename rewrite that grew back past the cursor.
      const reset =
        prior !== undefined && (ino !== prior.ino || size < prior.offset);
      const start = reset || prior === undefined ? 0 : prior.offset;
      if (start >= size) {
        return ok({ buf: Buffer.alloc(0), start, size, mtimeMs, ino, reset });
      }
      const buf = Buffer.alloc(size - start);
      // [LAW:no-silent-fallbacks] Zero padding from a short read fabricates entries.
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
      // [LAW:no-silent-failure] A close() rejection must not override the Outcome.
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
      // [LAW:no-silent-fallbacks] A short read must never yield zero padding.
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
      // [LAW:no-silent-failure] A close() rejection must not override the Outcome.
      await fh?.close().catch((e: unknown) => {
        debug(
          `transcript-fs: close failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
  });
}
