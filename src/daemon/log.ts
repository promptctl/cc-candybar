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

// The file now at the log's path and where its end is. The path is read per
// write (tests move $XDG_STATE_HOME), and the held descriptor is kept only while
// it is still that file: a state dir removed under the daemon, or a log another
// daemon rotated, puts a different file there (or none), and the next write goes
// to it, never into a file nobody reads.
function sinkAt(filePath: string): { held: Sink; end: number } {
  const st = statOrNull(filePath);
  if (sink === null || sink.path !== filePath || sink.ino !== st?.ino) {
    close();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT,
    );
    sink = { path: filePath, fd, ino: fs.fstatSync(fd).ino };
  }
  return { held: sink, end: st?.ino === sink.ino ? st.size : 0 };
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
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
// its bytes and the offset they go to. Each write names its offset rather than
// appending, so writing the same bytes there again changes nothing — which is
// what lets the way out finish a write it cannot see the end of.
let waiting: string[] = [];
let writing: {
  readonly fd: number;
  readonly bytes: Buffer;
  readonly at: number;
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
  let at: { held: Sink; end: number };
  try {
    // [LAW:single-enforcer] Path resolution reaches os.homedir(); it lives
    // inside the one boundary that makes dlog total.
    at = sinkAt(logPath());
  } catch (e) {
    unwritable(lines, e);
    pump();
    return;
  }
  const { held, end } = at;
  writeFrom(held, Buffer.from(lines), end);
}

// One write of `bytes` at `offset`, and of whatever a short write left after
// it, before the next batch.
function writeFrom(held: Sink, bytes: Buffer, offset: number): void {
  writing = { fd: held.fd, bytes, at: offset };
  fs.write(held.fd, bytes, 0, bytes.length, offset, (err, written) => {
    writing = null;
    if (err !== null) {
      close();
      unwritable(bytes.toString(), err);
    } else if (written < bytes.length) {
      writeFrom(held, bytes.subarray(written), offset + written);
      return;
    } else if (offset + written >= MAX_BYTES) {
      // Between writes, never under one: the rename moves a file no write holds.
      close();
      rotate(held.path);
    }
    pump();
  });
}

// On the way out, after the event loop's last turn: the write in flight is made
// again at its offset (whether or not it landed, the file then holds it once),
// and every line still waiting follows it.
function writeWaitingSync(): void {
  const out = writing;
  writing = null;
  if (out !== null) {
    try {
      fs.writeSync(out.fd, out.bytes, 0, out.bytes.length, out.at);
    } catch (e) {
      unwritable(out.bytes.toString(), e);
    }
  }
  if (waiting.length === 0) return;
  const lines = waiting.join("");
  waiting = [];
  try {
    const { held, end } = sinkAt(logPath());
    fs.writeSync(held.fd, lines, end);
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
