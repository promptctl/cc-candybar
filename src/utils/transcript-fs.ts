import {
  open as fsOpen,
  readdir as fsReaddir,
  stat as fsStat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { Limiter } from "./limiter";
import { SingleFlight } from "./single-flight";

import { ABSENT, failed, ok, type Outcome } from "./outcome";
import { debug } from "./logger";

// [LAW:single-enforcer] The one per-render freshness probe: a SYNC single-file
// stat's stamp. Sync by design — the gate must resolve before deciding whether
// to read, and a sync stat consumes no gate slot (the async
// `readAppended`/`readTail` bulk reads are what the limiter bounds).
//
// A stamp is only ever a reason to SKIP a read: a consumer that holds a fold at
// this stamp has the file as it stands. "" is no stamp — no path, or a stat
// that failed for ANY reason — so a consumer never takes "" as a hit. With a
// path, it reads; with none, what it serves is its own call (the usage store
// keeps its last record, since nothing has replaced it). Whether a file that
// IS named is absent (ENOENT) or unreadable (EACCES, EIO) is the read's call,
// not the stat's: `readAppended`/`readTail` answer `absent` or `failed` with
// the reason. A stat that classified the same error would be a second
// enforcer of its read's rule.
export function statStamp(filePath: string | undefined): string {
  if (!filePath) return "";
  try {
    const stat = statSync(filePath, { bigint: true });
    return stat.isFile() ? transcriptVersion(stat) : "";
  } catch {
    return "";
  }
}

// [LAW:one-source-of-truth] Aliases of the same regular file and version
// share windows. A replacement, append or in-place change has another
// identity even when the path or the size stays the same.
export function transcriptVersion(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
}

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
// started: `reads` gated reads, `bytes` read off disk (a long line's scan and
// whole re-read included), `longLines` lines longer than the window read
// whole, and the longest of them — the one buffer a read allocates beyond the
// slots' windows. daemon-stats reports it as `transcriptReads`.
export interface TranscriptReads {
  readonly reads: number;
  readonly bytes: number;
  readonly longLines: number;
  readonly largestLine: number;
}

// [LAW:no-shared-mutable-globals] One owner: readAppended is the only writer,
// inside its gate slot, so every forward read is counted — a fold's and the
// first-line check of a sidechain alike. Read through transcriptReads().
const totals = { reads: 0, bytes: 0, longLines: 0, largestLine: 0 };

export function transcriptReads(): TranscriptReads {
  return { ...totals };
}

// The whole lines one forward read reached: `lines` (empty when it reached
// no newline before its end — a partial trailing line waits for its newline),
// so `start + lines.length` is the next read's offset. `atEnd` says the read
// reached its end — the cap, or EOF — so a further read would find no whole
// line. `size`/`stamp`/`ino` are the stat this read took. `longLine` is the
// length of a line longer than the window that was read whole, 0 for none.
export interface WholeLines {
  readonly lines: Buffer;
  readonly start: number;
  readonly atEnd: boolean;
  readonly size: number;
  readonly stamp: string;
  readonly ino: number;
  readonly reset: boolean;
  readonly longLine: number;
}

// A read whose `lines` may be a view of a lent window: disposing it gives the
// window back. Its consumer disposes the loan before returning the text.
export type AppendedLines = WholeLines & Disposable;

// [LAW:no-shared-mutable-globals] The window buffers: a read takes one as it
// enters its gate slot and lends it to its caller, who gives it back as soon
// as the lines are decoded. A queued fold holds none, a fold
// allocates no window buffer per window or per file for the garbage collector
// to find, and at most TRANSCRIPT_FS_CONCURRENCY are kept (4 MiB): a burst can
// lend a few more — a woken waiter takes one before the reader it followed
// has decoded — and those the collector takes back (brandon-unfiled-3248.bfnj).
const windows: Buffer[] = [];

function giveBack(window: Buffer): void {
  if (windows.length < TRANSCRIPT_FS_CONCURRENCY) windows.push(window);
}

// [LAW:single-enforcer] The forward complement of readTail, through the SAME
// gate: the whole lines of an append-only file from `prior.offset` (the file
// start when `prior` is undefined) up to `until` (EOF when undefined), at most
// one window of them unless one line is longer. One open→stat→read→close per
// gate slot, exactly like readTail. A transcript scanner that maintains a
// byte cursor MUST use this, not raw node:fs, or it reintroduces the
// unbounded-fs state the gate forbids.
//
// The window is lent rather than decoded inside the slot, so a read's result
// never carries what the caller decodes: a fold keeps the result (its cursor
// fields) across `step`'s await, and decoded entries kept across an I/O wait
// outlive the other folds' allocations and are promoted to the old
// generation — four concurrent cold folds of a 29 MB transcript grew RSS
// +88 MB instead of +23 MB (`scripts/fold-cost.mts`).
//
// [LAW:single-enforcer] A line longer than the window is handled here and
// nowhere else: a full window holding no newline scans on, window by window,
// for the newline that ends the line, then reads the line whole into a buffer
// of exactly its length — so every caller gets complete lines only, and a
// partial line still being written (no newline before the end) allocates
// nothing and reports no long line. Cutting at a newline also cuts on a UTF-8
// boundary (0x0A is never a continuation byte).
//
// [LAW:one-source-of-truth] `reset` is the single signal that the caller's
// cursor is no longer a prefix of this file — a truncation or /compact
// rewrite — so the caller discards its prior fold and re-folds from the
// returned bytes, which then start at offset 0. `until` belongs to the file
// the cursor was a prefix of, so a reset read ignores it.
//
// [LAW:no-silent-failure] ENOENT (fresh session, no transcript yet) is `absent`;
// any other error is `failed`, carrying its reason to the boundary that logs.
export async function readAppended(
  path: string,
  prior: { offset: number; ino: number } | undefined,
  until: number | undefined,
): Promise<Outcome<AppendedLines>> {
  return gate.run(async () => {
    const window = windows.pop() ?? Buffer.allocUnsafe(FOLD_WINDOW_BYTES);
    const read = await readWholeLines(path, prior, until, window);
    if (read.kind !== "ok") {
      giveBack(window);
      return read;
    }
    // Given back once however often it is disposed: a window in the pool
    // twice would be filled by two reads at once.
    let lent: Buffer | undefined = window;
    return ok({
      ...read.value,
      [Symbol.dispose]: () => {
        if (lent !== undefined) giveBack(lent);
        lent = undefined;
      },
    });
  });
}

type ForwardText = Omit<WholeLines, "lines"> & {
  readonly text: string;
  readonly bytes: number;
};
interface TailText {
  readonly text: string;
  readonly fromStart: boolean;
}
interface Observed<T> {
  readonly value: T;
  readonly stamp: string;
  readonly bytes: number;
}

// [LAW:no-shared-mutable-globals] The transcript filesystem owns these
// short-lived immutable windows. Sessions keep their own projections.
// Only a successful observation of the same regular file version and range
// can join or hit. Each pool keeps eight windows of up to 512 KiB of input.
class Observations<T> {
  private readonly pending = new SingleFlight();
  private readonly recent = new Map<string, T>();

  async read(
    path: string,
    range: string,
    read: () => Promise<Outcome<Observed<T>>>,
  ): Promise<Outcome<T>> {
    const stamp = statStamp(path);
    if (stamp === "") return observedValue(await read());
    const key = `${stamp}|${range}`;
    const recent = this.recent.get(key);
    if (recent !== undefined) {
      this.recent.delete(key);
      this.recent.set(key, recent);
      return ok(recent);
    }
    const { observed, originalPath } = await this.pending.run(key, async () => {
      const observed = await read();
      if (
        observed.kind === "ok" &&
        observed.value.stamp === stamp &&
        observed.value.bytes <= FOLD_WINDOW_BYTES
      ) {
        this.recent.set(key, observed.value.value);
        if (this.recent.size > TRANSCRIPT_FS_CONCURRENCY) {
          const oldest = this.recent.keys().next();
          if (!oldest.done) this.recent.delete(oldest.value);
        }
      }
      return { observed, originalPath: path };
    });
    // An alias could disappear or switch to another file between stat and
    // open, independently of this caller's path.
    return observedValue(
      originalPath === path ||
        (observed.kind === "ok" && observed.value.stamp === stamp)
        ? observed
        : await read(),
    );
  }
}

function observedValue<T>(found: Outcome<Observed<T>>): Outcome<T> {
  return found.kind === "ok" ? ok(found.value.value) : found;
}

const forward = new Observations<ForwardText>();
const tails = new Observations<TailText>();

export function readAppendedText(
  path: string,
  prior: { offset: number; ino: number } | undefined,
  until: number | undefined,
): Promise<Outcome<ForwardText>> {
  const range = JSON.stringify([prior?.offset, prior?.ino, until]);
  return forward.read(path, range, async () => {
    const read = await readAppended(path, prior, until);
    if (read.kind !== "ok") return read;
    using lent = read.value;
    const { lines, [Symbol.dispose]: _dispose, ...info } = lent;
    const bytes = lines.length;
    return ok({
      stamp: info.stamp,
      bytes,
      value: { ...info, bytes, text: lines.toString("utf8") },
    });
  });
}

export function readTailText(
  path: string,
  maxBytes: number,
): Promise<Outcome<TailText>> {
  return tails.read(path, String(maxBytes), async () => {
    const read = await readTail(path, maxBytes);
    if (read.kind !== "ok") return read;
    const { stamp, fromStart, buf } = read.value;
    return ok({
      stamp,
      bytes: buf.length,
      value: { text: buf.toString("utf8"), fromStart },
    });
  });
}

// readAppended's file work, inside its gate slot: the whole lines into
// `window` (or, for a long line, a buffer of its own), the file closed
// before it returns.
async function readWholeLines(
  path: string,
  prior: { offset: number; ino: number } | undefined,
  until: number | undefined,
  window: Buffer,
): Promise<Outcome<WholeLines>> {
  let fh: FileHandle | null = null;
  try {
    fh = await fsOpen(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = await fh.stat({ bigint: true });
    if (!st.isFile())
      return failed(`readAppended ${path}: not a regular file`, "read");
    const size = Number(st.size);
    const ino = Number(st.ino);
    const stamp = transcriptVersion(st);
    // [LAW:one-source-of-truth] The prior fold is a valid PREFIX of this file
    // only while the file stays append-only. Two independent signals break
    // that: the inode changed (a rename-based /compact or log rotation swapped
    // the file under the path), or the file shrank below our cursor (an
    // in-place truncate). Either ⇒ re-read from 0.
    const reset =
      prior !== undefined && (ino !== prior.ino || size < prior.offset);
    const start = reset || prior === undefined ? 0 : prior.offset;
    const end = reset || until === undefined ? size : Math.min(size, until);
    let bytesRead = 0;
    // The window's bytes, then — when they hold no newline — the scan for
    // the one that ends the line. A short read (the file shrank under us)
    // ends the read as EOF does.
    const first = await readInto(fh, window.subarray(0, end - start), start);
    bytesRead += first.length;
    let lastNl = first.lastIndexOf(0x0a);
    let reached = start + first.length;
    let shortRead = first.length < Math.min(window.length, end - start);
    while (lastNl < 0 && reached < end && !shortRead) {
      const next = await readInto(
        fh,
        window.subarray(0, end - reached),
        reached,
      );
      bytesRead += next.length;
      const nl = next.indexOf(0x0a);
      if (nl >= 0) lastNl = reached - start + nl;
      shortRead = next.length < Math.min(window.length, end - reached);
      reached += next.length;
    }
    const bytes = lastNl + 1;
    const longLine = bytes > window.length ? bytes : 0;
    // A long line is read once more, whole, now that its length is known.
    const wholeLines =
      longLine > 0
        ? await readInto(fh, Buffer.allocUnsafe(bytes), start)
        : first.subarray(0, bytes);
    bytesRead += longLine > 0 ? wholeLines.length : 0;
    // A long line's re-read that comes back short (the file shrank between
    // the scan and the read) is EOF, as a short read is everywhere here, and
    // its fragment is no line.
    const complete = wholeLines.length === bytes;
    totals.reads++;
    totals.bytes += bytesRead;
    totals.longLines += longLine > 0 ? 1 : 0;
    totals.largestLine = Math.max(totals.largestLine, longLine);
    return ok({
      lines: complete ? wholeLines : wholeLines.subarray(0, 0),
      start,
      // A long line was found by its newline alone, so lines after it may
      // still be unread; otherwise the read saw everything up to its end.
      atEnd:
        !complete ||
        (longLine > 0 ? start + bytes >= end : reached >= end || shortRead),
      size,
      stamp,
      ino,
      reset,
      longLine,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
    return failed(
      `readAppended ${path}: ${e instanceof Error ? e.message : String(e)}`,
      "read",
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
): Promise<Outcome<{ buf: Buffer; fromStart: boolean; stamp: string }>> {
  return gate.run(async () => {
    let fh: FileHandle | null = null;
    try {
      fh = await fsOpen(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await fh.stat({ bigint: true });
      if (!stat.isFile())
        return failed(`readTail ${path}: not a regular file`, "read");
      const size = Number(stat.size);
      const start = Math.max(0, size - maxBytes);
      return ok({
        buf: await readInto(fh, Buffer.alloc(size - start), start),
        fromStart: start === 0,
        stamp: transcriptVersion(stat),
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
      return failed(
        `readTail ${path}: ${e instanceof Error ? e.message : String(e)}`,
        "read",
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
