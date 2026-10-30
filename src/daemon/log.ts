import fs from "node:fs";
import path from "node:path";
import { logPath } from "./paths";
import type { LogLevel } from "../utils/logger";

export const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

// The whole log's lines, oldest first: the rotated generations, then the live
// file. A rotation can move a generation between listing and reading it, so a
// reader that lands just after one finds its lines in the next, or no live
// file yet. A line is in the log once its newline is: a read that lands while
// a batch is still being written sees the batch's start, so whatever follows
// the last newline is left for the next read.
// [LAW:one-source-of-truth] Whatever reads the whole log reads it here.
export function logLines(filePath: string): string[] {
  return [
    ...Array.from(
      { length: KEEP_GENERATIONS },
      (_, i) => `${filePath}.${KEEP_GENERATIONS - i}`,
    ),
    filePath,
  ].flatMap((f) => {
    try {
      return fs.readFileSync(f, "utf8").split("\n").slice(0, -1);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  });
}
// The bytes the log holds waiting for the disk. Past this the oldest waiting
// lines are dropped and counted, and the count is logged ahead of the lines
// kept, so a stalled disk costs lines the log says it lost, never the daemon's
// memory, and the newest lines — a death line among them — are kept.
export const MAX_WAITING_BYTES = 4 * 1024 * 1024;

// [LAW:no-ambient-temporal-coupling] A line leaves the event loop at once and
// reaches the file through one write at a time, and whatever is still waiting
// when the process exits is written synchronously on the way out — so the
// death line each shutdown path writes last is in the file, and no render waits
// on the disk. A synchronous write per line put the disk on every request: a
// write that a busy disk held for hundreds of milliseconds held every waiting
// statusline client past its budget, and each client that gave up was one more
// line. So the file's identity, its opening and its rotation are asked of the
// disk off the loop too, and the descriptor stays open between writes.
//
// Writes append (O_APPEND), which the kernel makes atomic beside another
// process appending: two daemons overlap at every handoff, and the old one's
// death line and the new one's first lines land together.
//
// [LAW:polishing-by-subtraction] exception: the queue, the batch's state and
// the exit listener are what a write off the loop costs. A synchronous append
// is no longer microseconds where it matters: measured at ~0.6 ms a line idle,
// and up to 450 ms on a busy disk, on every request.
//
// [LAW:types-are-the-program] The open log is one value, or none: the file it
// is and its descriptor.
interface Sink {
  readonly path: string;
  readonly fd: number;
  // The file it is: an inode is unique only within its device.
  readonly id: string;
}
let sink: Sink | null = null;

function close(): void {
  if (sink === null) return;
  try {
    fs.closeSync(sink.fd);
  } catch {}
  sink = null;
}

// The file now at the log's path, held open, and its size. The path is read
// per write (tests move $XDG_STATE_HOME), and the held descriptor is kept only
// while it is still that file: a state dir removed under the daemon, or a log
// another daemon rotated, puts a different file there (or none), and the next
// write goes to it, never into a file nobody reads.
// One stat a write, not a line: lines arriving while a write is out go in the
// next one together. Asked less often, the lines between a state dir's removal
// and the next ask would go into a file nobody can read.
async function sinkAt(filePath: string): Promise<{ held: Sink; size: number }> {
  const st = await fs.promises.stat(filePath).catch(() => null);
  if (
    sink !== null &&
    sink.path === filePath &&
    st !== null &&
    sink.id === idOf(st)
  ) {
    return { held: sink, size: st.size };
  }
  close();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const fd = await new Promise<number>((resolve, reject) =>
    fs.open(filePath, "a", (err, opened) =>
      err === null ? resolve(opened) : reject(err),
    ),
  );
  const opened = await new Promise<fs.Stats>((resolve, reject) =>
    fs.fstat(fd, (err, stats) => (err === null ? resolve(stats) : reject(err))),
  );
  sink = { path: filePath, fd, id: idOf(opened) };
  return { held: sink, size: opened.size };
}

function idOf(st: fs.Stats): string {
  return `${st.dev}:${st.ino}`;
}

function writeAt(fd: number, bytes: Buffer): Promise<number> {
  return new Promise((resolve, reject) =>
    fs.write(fd, bytes, (err, written) =>
      err === null ? resolve(written) : reject(err),
    ),
  );
}

// Self-rotation: when daemon.log exceeds MAX_BYTES, shift .1→.2, .2→.3, drop
// the oldest, and start fresh. Daemon-internal so we don't depend on any
// external rotator. It runs between writes, never under one.
async function rotate(filePath: string): Promise<void> {
  for (let i = KEEP_GENERATIONS - 1; i >= 1; i--) {
    await fs.promises
      .rename(`${filePath}.${i}`, `${filePath}.${i + 1}`)
      .catch(() => {});
  }
  await fs.promises.rename(filePath, `${filePath}.1`).catch(() => {});
}

// Lines not yet taken and their bytes, the count of the oldest dropped to stay
// within what the log holds, and the batch taken and on its way.
let waiting: string[] = [];
let waitingBytes = 0;
let dropped = 0;
let droppedBytes = 0;
// [LAW:types-are-the-program] Where a batch is: taken and not yet written, its
// write out (to that descriptor, the file reaching that size once it lands),
// or landed — after which nothing about it is the way out's to finish.
interface Batch {
  readonly bytes: Buffer;
  state:
    | { readonly kind: "taken" }
    | { readonly kind: "issued"; readonly fd: number; readonly endsAt: number }
    | { readonly kind: "landed" };
}
let onItsWay: Batch | null = null;
// Set by the flush itself as it starts and cleared as it ends, so a flush that
// ends without ever yielding leaves the next line free to start another.
let flushing = false;
const drainedWaiters: Array<() => void> = [];
// Once the process is exiting, no flush will run again: a line logged then —
// by an exit listener after this one — is written as it is logged.
let exiting = false;
let exitArmed = false;

// [LAW:one-source-of-truth] One line of the log as it lands in the file: when,
// at what level, and the message. Whatever writes a log line spells it here.
export function logLine(level: LogLevel, msg: string): string {
  return `${new Date().toISOString()} [${level}] ${msg}\n`;
}

export function dlog(level: LogLevel, msg: string): void {
  const line = logLine(level, msg);
  if (!exitArmed) {
    exitArmed = true;
    process.on("exit", () => {
      exiting = true;
      writeWaitingSync(true, EXIT_WAIT_MS);
    });
  }
  waiting.push(line);
  waitingBytes += Buffer.byteLength(line);
  // The newest lines are the ones kept — the death line is always among them.
  // Dropped down to half at once, so a disk that stays stalled costs a drop
  // now and then rather than one on every line.
  if (waitingBytes > MAX_WAITING_BYTES) {
    let cut = 0;
    while (waitingBytes > MAX_WAITING_BYTES / 2 && cut < waiting.length - 1) {
      const bytes = Buffer.byteLength(waiting[cut]!);
      waitingBytes -= bytes;
      droppedBytes += bytes;
      cut++;
    }
    waiting.splice(0, cut);
    dropped += cut;
  }
  if (exiting) writeWaitingSync(true, EXIT_WAIT_MS);
  else if (!flushing) void flush();
}

// Resolves once every line logged so far is in the file (or reported unwritable).
export function drained(): Promise<void> {
  if (!flushing) return Promise.resolve();
  return new Promise((resolve) => drainedWaiters.push(resolve));
}

// What is waiting, written now, synchronously: for a caller about to block the
// loop on the way to a death that may come with no exit event (a heap
// snapshot, which can draw the OS's kill), so what explains it is on disk first.
// The wait for a write already out may be long here: a snapshot that holds
// the loop for seconds follows it anyway.
export function writeWaitingNow(): void {
  writeWaitingSync(false, BREACH_WAIT_MS);
}

// One write at a time until nothing waits.
async function flush(): Promise<void> {
  flushing = true;
  try {
    while (waiting.length > 0) {
      const lines = take();
      onItsWay = { bytes: Buffer.from(lines), state: { kind: "taken" } };
      try {
        // [LAW:single-enforcer] Path resolution reaches os.homedir(); it lives
        // inside the one boundary that makes dlog total.
        await append(logPath(), onItsWay);
      } catch (e) {
        // The failed write is done: the next batch opens the file afresh, so
        // a state dir removed under the daemon is recreated for it. A batch a
        // synchronous caller wrote meanwhile is in the file, not lost.
        close();
        if (onItsWay.state.kind !== "landed") unwritable(lines, e);
      } finally {
        onItsWay = null;
      }
    }
  } finally {
    flushing = false;
    for (const resolve of drainedWaiters.splice(0)) resolve();
  }
}

// Everything waiting, after the count of the lines dropped before it.
function take(): string {
  const lost =
    dropped === 0
      ? ""
      : logLine(
          "warn",
          `log: ${dropped} earlier line(s) dropped (${droppedBytes} bytes): more than ${MAX_WAITING_BYTES} bytes were waiting for the disk`,
        );
  const lines = lost + waiting.join("");
  waiting = [];
  waitingBytes = 0;
  dropped = 0;
  droppedBytes = 0;
  return lines;
}

async function append(filePath: string, batch: Batch): Promise<void> {
  const { held, size } = await sinkAt(filePath);
  // Written meanwhile, synchronously, by a caller that could not wait.
  if (batch.state.kind === "landed") return;
  const { bytes } = batch;
  const endsAt = size + bytes.length;
  batch.state = { kind: "issued", fd: held.fd, endsAt };
  for (let done = 0; done < bytes.length; ) {
    const written = await writeAt(held.fd, bytes.subarray(done));
    // A write that takes nothing would be asked again forever.
    if (written === 0) throw new Error("the disk took 0 bytes of a write");
    done += written;
  }
  batch.state = { kind: "landed" };
  if (endsAt >= MAX_BYTES) {
    close();
    // Only while the path is still the file that filled: another daemon may
    // have rotated it and started a fresh one there.
    const now = await fs.promises.stat(held.path).catch(() => null);
    if (now !== null && idOf(now) === held.id) await rotate(held.path);
  }
}

// How long a synchronous write of what is waiting waits for a write already
// out to land first. The threadpool writes on while this thread blocks, so a
// write that is out lands within this unless the disk is stalled or the write
// never started: the slowest write measured on a busy disk took ~450 ms.
const EXIT_WAIT_MS = 1000;
const BREACH_WAIT_MS = 2000;

// On the way out, after the event loop's last turn (or now, for a caller that
// cannot wait): a batch not yet written is written; one whose write is out is
// waited for, as the file's size says, so the lines after it follow it in
// order — and on the way out, one that has not landed by then is written
// again, since a write that never started never will. Every line still
// waiting follows.
// [LAW:no-silent-failure] exception: the size misleads in two ways, each
// costing that one batch: another process appending while it is out makes it
// look landed (lost), and a write that starts after the wait gave up lands
// beside its rewrite (doubled). A write at an offset of its own would answer
// exactly, and would overwrite the other daemon's lines at every handoff.
function writeWaitingSync(finishing: boolean, waitMs: number): void {
  const out = onItsWay;
  let first: Buffer = Buffer.alloc(0);
  if (out !== null && out.state.kind === "taken") {
    first = out.bytes;
    // The flush that took it finds it landed, and goes no further with it.
    out.state = { kind: "landed" };
  }
  let stillOut: { fd: number; endsAt: number } | null = null;
  if (out !== null && out.state.kind === "issued") {
    const { fd, endsAt } = out.state;
    try {
      const size = sizeOnceLanded(fd, endsAt, waitMs);
      if (size < endsAt && finishing) {
        first = out.bytes.subarray(
          Math.max(0, size - (endsAt - out.bytes.length)),
        );
        out.state = { kind: "landed" };
      } else if (size < endsAt) {
        stillOut = { fd, endsAt };
      }
    } catch (e) {
      // Where the write stands cannot be asked: on the way out it is written
      // again — doubled at worst, never lost.
      if (finishing) {
        first = out.bytes;
        out.state = { kind: "landed" };
      }
      unwritable(out.bytes.toString(), e);
    }
  }
  if (first.length === 0 && waiting.length === 0) return;
  const lines = Buffer.concat([first, Buffer.from(take())]);
  try {
    const filePath = logPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, lines);
    // A write still out lands after these lines now: the file it lands in
    // ends that much further on, if these went to that file.
    if (
      stillOut !== null &&
      out !== null &&
      idOf(fs.fstatSync(stillOut.fd)) === idOf(fs.statSync(filePath))
    ) {
      out.state = {
        kind: "issued",
        fd: stillOut.fd,
        endsAt: stillOut.endsAt + lines.length,
      };
    }
  } catch (e) {
    // The sink is left open: a write still out holds its descriptor, and
    // closed now, its number could go to the next file opened (a heap
    // snapshot) and the write land in it.
    unwritable(lines.toString(), e);
  }
}

// The file's size once it reaches `endsAt`, or as it stands when the wait is
// over. Blocking: only a caller that cannot yield waits here.
function sizeOnceLanded(fd: number, endsAt: number, waitMs: number): number {
  // Monotonic: a clock stepped while this thread blocks neither stretches the
  // wait nor ends it early.
  const until = performance.now() + waitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const { size } = fs.fstatSync(fd);
    if (size >= endsAt || performance.now() >= until) return size;
    Atomics.wait(nap, 0, 0, 1);
  }
}

function unwritable(lines: string, e: unknown): void {
  // [LAW:no-silent-failure] exception: the failure IS the log sink, so it
  // cannot be reported through the log sink. A throw here would escape the
  // crash handlers that call dlog first (uncaughtException → dlog →
  // shutdown), taking the clean-death path down with it. stderr carries the
  // line and the reason — the terminal when the daemon runs by hand, and
  // /dev/null under a detached spawn; the daemon keeps serving either way.
  try {
    process.stderr.write(
      `${lines}cc-candybar: daemon.log unwritable: ${(e as Error).message}\n`,
    );
  } catch {
    // stderr was the last channel.
  }
}
