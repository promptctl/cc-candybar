import {
  open as fsOpen,
  readdir as fsReaddir,
  stat as fsStat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";

import { ABSENT, failed, ok, type Outcome } from "./outcome";
import { debug } from "./logger";

// [LAW:single-enforcer] The one per-render freshness probe: a SYNC single-file
// stat's stamp ("" when the file is absent or unreadable). Sync by design — the
// gate must resolve before deciding whether to read, and a sync stat consumes
// no gate slot (the async `readAppended`/`readTail` bulk reads are what the
// limiter bounds). Both the usage store and the metrics provider key their
// incremental fold off this one helper so the ENOENT→"" policy lives in one place.
export function statStamp(filePath: string | undefined): string {
  if (!filePath) return "";
  try {
    return stampOf(statSync(filePath));
  } catch {
    return "";
  }
}

// [LAW:one-source-of-truth] A transcript's version as stat reports it,
// `mtimeMs:size` like the git config stamp: an append that lands inside the
// mtime tick of the read before it (a coarse-timestamp filesystem) moves only
// the size, and an mtime alone would then call the file unchanged for good —
// for a session that never renders, nothing else would ever read that tail.
export function stampOf(st: { mtimeMs: number; size: number }): string {
  return `${st.mtimeMs}:${st.size}`;
}

// [LAW:single-enforcer] One owner of the transcript-scanning in-flight-I/O
// budget. Every readdir/stat/read over the ~/.claude/projects tree passes
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
export const stat = gated(fsStat);

// The most bytes one forward read takes from a transcript. A cold fold of a
// 29 MB transcript used to read it whole — one Buffer, one string, every
// entry at once, ~106 MB RSS (brandon-unfiled-3248.bfnj) — so a fold now
// walks the file one window at a time and holds only the window it is on.
// Under 1 MB on purpose: Node decodes a buffer longer than ~1 MB
// (StringBytes' EXTERN_APEX) into an EXTERNAL string, freed only by a full
// GC, and 1 MiB windows piled up 30 MB of them per fold. Measured with
// `scripts/fold-cost.mts` on a 29 MB transcript: one cold fold +17 MB RSS at
// 512 KiB against +28 MB at 1 MiB; four at once +22 MB against +111 MB.
export const FOLD_WINDOW_BYTES = 512 * 1024;

// [LAW:nothing-unseen] What every forward read has cost since the daemon
// started: `reads` gated reads, `bytes` read off disk (a widened read's
// re-reads included), `widened` doublings past the window, and the largest
// single buffer one read allocated. daemon-stats reports it as
// `transcriptReads`.
export interface TranscriptReads {
  readonly reads: number;
  readonly bytes: number;
  readonly widened: number;
  readonly largestRead: number;
}

// [LAW:no-shared-mutable-globals] One owner: readAppended is the only writer,
// inside its gate slot, so every forward read is counted — a fold's and the
// first-line check of a sidechain alike. Read through transcriptReads().
const totals = { reads: 0, bytes: 0, widened: 0, largestRead: 0 };

export function transcriptReads(): TranscriptReads {
  return { ...totals };
}

// The whole lines one forward read returned: `buf` runs from `start` through
// the last newline the read reached (empty when it reached none before EOF —
// a partial trailing line waits for its newline). `buf` may be a view of the
// caller's scratch buffer, so it is read before the next read into it. `size`/`stamp`/`ino` are the
// stat this read took. `widened` is how many times the window doubled to
// reach a newline; `bytesRead` what it read off disk, re-reads included;
// `largestRead` the largest buffer it allocated.
export interface AppendedLines {
  readonly buf: Buffer;
  readonly start: number;
  readonly size: number;
  readonly stamp: string;
  readonly ino: number;
  readonly reset: boolean;
  readonly widened: number;
  readonly bytesRead: number;
  readonly largestRead: number;
}

// [LAW:single-enforcer] The forward complement of readTail, through the SAME
// gate: the whole lines of an append-only file from `prior.offset` (the file
// start when `prior` is undefined), at most one `scratch` buffer of them unless
// one line is longer. Reading into the caller's buffer, which it reuses window
// after window, keeps a fold from leaving a window-sized buffer behind per
// window for the garbage collector to find (brandon-unfiled-3248.bfnj). One open→stat→read→close per gate slot, exactly like readTail. A
// transcript scanner that maintains a byte cursor MUST use this, not raw
// node:fs, or it reintroduces the unbounded-fs state the gate forbids.
//
// [LAW:single-enforcer] Widening lives here and nowhere else: a full window
// holding no newline is one line longer than the window, so the read doubles
// and re-reads from the same start until it reaches a newline or EOF. A line
// of any length comes back whole, and every caller gets complete lines only.
// Cutting at a newline also cuts on a UTF-8 boundary (0x0A is never a
// continuation byte).
//
// [LAW:one-source-of-truth] `reset` is the single signal that the caller's
// cursor is no longer a prefix of this file — a truncation or /compact
// rewrite — so the caller discards its prior fold and re-folds from the
// returned bytes, which then start at offset 0.
//
// [LAW:no-silent-failure] ENOENT (fresh session, no transcript yet) is `absent`;
// any other error is `failed`, carrying its reason to the boundary that logs.
export async function readAppended(
  path: string,
  prior: { offset: number; ino: number } | undefined,
  scratch: Buffer,
): Promise<Outcome<AppendedLines>> {
  return gate.run(async () => {
    let fh: FileHandle | null = null;
    try {
      fh = await fsOpen(path, "r");
      const st = await fh.stat();
      const { size, ino } = st;
      const stamp = stampOf(st);
      // [LAW:one-source-of-truth] The prior fold is a valid PREFIX of this file
      // only while the file stays append-only. Two independent signals break
      // that: the inode changed (a rename-based /compact or log rotation swapped
      // the file under the path), or the file shrank below our cursor (an
      // in-place truncate). Either ⇒ re-read from 0.
      const reset =
        prior !== undefined && (ino !== prior.ino || size < prior.offset);
      const start = reset || prior === undefined ? 0 : prior.offset;
      let window = scratch;
      let widened = 0;
      let bytesRead = 0;
      let largestRead = 0;
      let buf: Buffer;
      for (;;) {
        const read = await readInto(
          fh,
          window.subarray(0, Math.min(window.length, size - start)),
          start,
        );
        bytesRead += read.length;
        largestRead = Math.max(largestRead, read.length);
        const lastNl = read.lastIndexOf(0x0a);
        // A short read (the file shrank under us) is EOF as well.
        const atEof =
          start + read.length >= size || read.length < window.length;
        if (lastNl >= 0 || atEof) {
          buf = read.subarray(0, lastNl + 1);
          break;
        }
        window = Buffer.allocUnsafe(window.length * 2);
        widened++;
      }
      totals.reads++;
      totals.bytes += bytesRead;
      totals.widened += widened;
      totals.largestRead = Math.max(totals.largestRead, largestRead);
      return ok({
        buf,
        start,
        size,
        stamp,
        ino,
        reset,
        widened,
        bytesRead,
        largestRead,
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

// Fill `buf` from `position`, fewer bytes only at EOF. [LAW:no-silent-failure]
// A single read may return short — parsing the unread rest of the buffer
// would fabricate entries — so it loops until the buffer fills or EOF, and
// returns only the bytes actually read.
async function readInto(
  fh: FileHandle,
  buf: Buffer,
  position: number,
): Promise<Buffer> {
  let off = 0;
  while (off < buf.length) {
    const { bytesRead } = await fh.read(
      buf,
      off,
      buf.length - off,
      position + off,
    );
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return buf.subarray(0, off);
}

// [LAW:single-enforcer] A bounded tail read through the SAME gate: the last
// `maxBytes` of a file (the whole file when smaller), plus whether that window
// reaches the file start. The open→stat→read→close runs under one gate slot, so
// a tail read counts as one in-flight op exactly like a stat — a transcript
// scanner that grows its window backward must use THIS, not raw node:fs, or it
// reintroduces the unbounded-fs state the gate forbids.
//
// [LAW:no-silent-failure] The file not existing is the expected, every-render
// case for a fresh session (no transcript yet) — `absent`. Any other error
// (permissions, I/O) is a real read failure — `failed`, carrying its reason
// to whichever boundary owns the log effect. Folding both into one null made
// a broken transcript indistinguishable from a missing one.
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
      return ok({
        buf: await readInto(fh, Buffer.alloc(size - start), start),
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

// [LAW:one-source-of-truth] exception: readTail for a caller that must not yield — a
// doctor probe, which runs synchronously on the daemon's loop. Outside the
// gate: a synchronous read holds its one descriptor only while nothing else
// runs. The window, the short-read loop, ENOENT as `absent` and the close that
// never overrides the read are readTail's, copied: a core generic over sync
// and async reads would cost more than these lines.
export function readTailSync(
  path: string,
  maxBytes: number,
): Outcome<{ buf: Buffer; fromStart: boolean; file: string }> {
  let fd: number;
  try {
    // [LAW:single-enforcer] THE read of a path someone else controls (a
    // client's transcript, a project's `.claude/` settings): non-blocking,
    // since a synchronous open of a FIFO with no writer would hold the
    // daemon's loop for good, and refused unless it is a regular file, which
    // a pipe or a directory is not. No file can sit under a component that is
    // not a directory, so ENOTDIR is absence beside ENOENT.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return ABSENT;
    return failed(e instanceof Error ? e.message : String(e));
  }
  try {
    // bigint: a 64-bit file id survives whole, so `file` names exactly the
    // file these bytes came from (two spellings of one path read alike).
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return failed("not a regular file");
    const size = Number(stat.size);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n === 0) break;
      off += n;
    }
    return ok({
      buf: buf.subarray(0, off),
      fromStart: start === 0,
      file: `${stat.dev}:${stat.ino}`,
    });
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  } finally {
    try {
      closeSync(fd);
    } catch (e) {
      debug(
        `transcript-fs: close failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
