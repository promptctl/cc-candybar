import fs from "node:fs";
import path from "node:path";
import { logPath } from "./paths";
import type { LogLevel } from "../utils/logger";

export const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

// [LAW:no-ambient-temporal-coupling] A line leaves the event loop at once and
// reaches the file through one write at a time, and whatever is still waiting
// when the process exits is written synchronously on the way out — so the
// death line each shutdown path writes last is in the file, and no render waits
// on the disk. A synchronous write per line put the disk on every request: a
// write that a busy disk held for hundreds of milliseconds held every waiting
// statusline client past its budget, and each client that gave up was one more
// line. The descriptor stays open between lines for the same reason: opening
// and closing the file per line cost ~0.6 ms idle and several under load.
//
// [LAW:types-are-the-program] The open log is one value, or none: the file it
// is, its descriptor, and the bytes it holds.
interface Sink {
  readonly path: string;
  readonly fd: number;
  bytes: number;
}
let sink: Sink | null = null;

function close(): void {
  if (sink === null) return;
  try {
    fs.closeSync(sink.fd);
  } catch {}
  sink = null;
}

// The held sink while it is still the file at the log's path, else a fresh
// open. The path is read per line (tests move $XDG_STATE_HOME), and a state dir
// removed out from under the daemon unlinks the file the descriptor holds, so
// the next line recreates it rather than writing into a file nobody can read.
function sinkFor(filePath: string): Sink {
  if (
    sink !== null &&
    sink.path === filePath &&
    fs.fstatSync(sink.fd).nlink > 0
  ) {
    return sink;
  }
  close();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  // The size on disk, so rotation triggers correctly across daemon restarts.
  sink = { path: filePath, fd, bytes: fs.fstatSync(fd).size };
  return sink;
}

// Self-rotation: when daemon.log exceeds MAX_BYTES, shift .1→.2, .2→.3, drop
// the oldest, and start fresh. Daemon-internal so we don't depend on any
// external rotator. Cheap because rotation only runs at the rollover boundary.
function rotate(filePath: string): void {
  for (let i = KEEP_GENERATIONS - 1; i >= 1; i--) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    try {
      fs.renameSync(src, dst);
    } catch {}
  }
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {}
}

// Lines not yet handed to a write, and the one write the file has been handed:
// its bytes, and the size the file reaches once they land.
let waiting: string[] = [];
let writing: {
  readonly fd: number;
  readonly bytes: Buffer;
  readonly endsAt: number;
} | null = null;
const drainedWaiters: Array<() => void> = [];
let exitArmed = false;

export function dlog(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  if (!exitArmed) {
    exitArmed = true;
    process.on("exit", writeWaitingSync);
  }
  waiting.push(line);
  pump();
}

// Resolves once every line logged so far is in the file (or reported unwritable).
export function drained(): Promise<void> {
  if (writing === null && waiting.length === 0) return Promise.resolve();
  return new Promise((resolve) => drainedWaiters.push(resolve));
}

// Hands everything waiting to one write, unless one is out already; its
// completion hands on whatever arrived meanwhile.
function pump(): void {
  if (writing !== null) return;
  if (waiting.length === 0) {
    for (const resolve of drainedWaiters.splice(0)) resolve();
    return;
  }
  const lines = waiting.join("");
  waiting = [];
  let held: Sink;
  try {
    // [LAW:single-enforcer] Path resolution reaches os.homedir(); it lives
    // inside the one boundary that makes dlog total.
    held = sinkFor(logPath());
  } catch (e) {
    unwritable(lines, e);
    pump();
    return;
  }
  const bytes = Buffer.from(lines);
  const out = { fd: held.fd, bytes, endsAt: held.bytes + bytes.length };
  writing = out;
  fs.write(held.fd, bytes, (err, written) => {
    writing = null;
    if (err !== null) {
      close();
      unwritable(lines, err);
    } else {
      held.bytes += written;
      // Between writes, never under one: the rename moves a file no write holds.
      if (held.bytes >= MAX_BYTES) {
        close();
        rotate(held.path);
      }
    }
    pump();
  });
}

// On the way out, after the event loop's last turn: the write in flight lands
// or not as the file's size says, and every line still waiting follows it.
function writeWaitingSync(): void {
  const out = writing;
  writing = null;
  if (out !== null) {
    try {
      const size = fs.fstatSync(out.fd).size;
      const start = out.endsAt - out.bytes.length;
      if (size < out.endsAt) {
        fs.writeSync(out.fd, out.bytes.subarray(Math.max(0, size - start)));
      }
    } catch (e) {
      unwritable(out.bytes.toString(), e);
    }
  }
  if (waiting.length === 0) return;
  const lines = waiting.join("");
  waiting = [];
  try {
    fs.writeSync(sinkFor(logPath()).fd, lines);
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
