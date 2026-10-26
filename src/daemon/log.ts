import fs from "node:fs";
import path from "node:path";
import { logPath } from "./paths";
import type { LogLevel } from "../utils/logger";

export const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_GENERATIONS = 3;
// What the log holds while the disk takes none of it. Past this a line is
// counted rather than held, and the count is logged once the disk takes lines
// again, so a stalled disk costs lines it says it lost, never the daemon's
// memory.
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
// [LAW:types-are-the-program] The open log is one value, or none: the file it
// is and its descriptor.
interface Sink {
  readonly path: string;
  readonly fd: number;
  readonly ino: number;
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
async function sinkAt(filePath: string): Promise<{ held: Sink; size: number }> {
  const st = await fs.promises.stat(filePath).catch(() => null);
  if (sink !== null && sink.path === filePath && sink.ino === st?.ino) {
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
  sink = { path: filePath, fd, ino: opened.ino };
  return { held: sink, size: opened.size };
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

// Lines not yet taken, the lines refused while the log was full, and the batch
// taken and on its way: its bytes, and once its write is out, the descriptor
// and the size the file reaches when they land.
let waiting: string[] = [];
let waitingBytes = 0;
let refused = 0;
let onItsWay: {
  readonly bytes: Buffer;
  issued: { readonly fd: number; readonly endsAt: number } | null;
} | null = null;
let flushing: Promise<void> | null = null;

export function dlog(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  if (waitingBytes + line.length > MAX_WAITING_BYTES) {
    refused++;
    return;
  }
  waiting.push(line);
  waitingBytes += line.length;
  flushing ??= flush();
}

// Resolves once every line logged so far is in the file (or reported unwritable).
export function drained(): Promise<void> {
  return flushing ?? Promise.resolve();
}

// One write at a time until nothing waits. The exit listener is there exactly
// while lines are on their way, so the way out writes what is still waiting.
async function flush(): Promise<void> {
  process.on("exit", writeWaitingSync);
  try {
    while (waiting.length > 0 || refused > 0) {
      const lines = take();
      onItsWay = { bytes: Buffer.from(lines), issued: null };
      try {
        // [LAW:single-enforcer] Path resolution reaches os.homedir(); it lives
        // inside the one boundary that makes dlog total.
        await append(logPath(), onItsWay);
      } catch (e) {
        unwritable(lines, e);
      } finally {
        onItsWay = null;
      }
    }
  } finally {
    process.off("exit", writeWaitingSync);
    flushing = null;
  }
}

// Everything waiting, and the count of lines refused after it.
function take(): string {
  const lost =
    refused === 0
      ? ""
      : `${new Date().toISOString()} [warn] log: ${refused} line(s) dropped while the disk took none\n`;
  const lines = waiting.join("") + lost;
  waiting = [];
  waitingBytes = 0;
  refused = 0;
  return lines;
}

async function append(
  filePath: string,
  batch: NonNullable<typeof onItsWay>,
): Promise<void> {
  const { held, size } = await sinkAt(filePath);
  const { bytes } = batch;
  batch.issued = { fd: held.fd, endsAt: size + bytes.length };
  for (let done = 0; done < bytes.length; ) {
    done += await writeAt(held.fd, bytes.subarray(done));
  }
  if (size + bytes.length >= MAX_BYTES) {
    close();
    await rotate(held.path);
  }
}

// On the way out, after the event loop's last turn: a batch whose write is out
// lands or not as the file's size says, one not yet written is written, and
// every line still waiting follows it.
// [LAW:no-silent-failure] exception: another process appending while that
// write is out misleads the size, which doubles or loses that one write. A
// write at an offset of its own would answer exactly, and would overwrite the
// other daemon's lines at every handoff instead.
function writeWaitingSync(): void {
  const out = onItsWay;
  onItsWay = null;
  const unsent = out?.issued === null ? out.bytes.toString() : "";
  if (out?.issued) {
    const { fd, endsAt } = out.issued;
    try {
      const size = fs.fstatSync(fd).size;
      const start = endsAt - out.bytes.length;
      if (size < endsAt) {
        fs.writeSync(fd, out.bytes.subarray(Math.max(0, size - start)));
      }
    } catch (e) {
      unwritable(out.bytes.toString(), e);
    }
  }
  if (unsent === "" && waiting.length === 0 && refused === 0) return;
  const lines = unsent + take();
  try {
    const filePath = logPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, lines);
  } catch (e) {
    unwritable(lines, e);
  }
}

function unwritable(lines: string, e: unknown): void {
  // [LAW:no-silent-failure] exception: the failure IS the log sink, so it
  // cannot be reported through the log sink. A throw here would escape the
  // crash handlers that call dlog first (uncaughtException → dlog →
  // shutdown), taking the clean-death path down with it. stderr carries the
  // line and the reason — the terminal when the daemon runs by hand, and
  // /dev/null under a detached spawn; the daemon keeps serving either way.
  // Closing the sink re-opens on the next call, so a state dir removed out
  // from under the daemon is recreated for the next line.
  close();
  try {
    process.stderr.write(
      `${lines}cc-candybar: daemon.log unwritable: ${(e as Error).message}\n`,
    );
  } catch {
    // stderr was the last channel.
  }
}
