import fs from "node:fs";
import path from "node:path";
import { logPath } from "./paths";
import type { LogLevel } from "../utils/logger";

export const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

// [LAW:no-ambient-temporal-coupling] Every line is a synchronous write, so a
// line is in the file the moment the call returns — including the death line
// each shutdown path writes last, which an async stream dropped whenever
// `process.exit` outran its flush. No stream means nothing to flush and no
// window in which a late writer can reopen a sink that nobody waits for.
//
// The descriptor stays open between lines. Opening and closing the file for
// each line cost ~0.6 ms a line idle and several under load, and the daemon
// writes a line for every request and every client that gave up waiting: past
// a few hundred lines a second the log was most of the event loop, and each
// line it delayed made another client give up and another line to write.
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

export function dlog(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  try {
    // [LAW:single-enforcer] Path resolution reaches os.homedir(); it lives
    // inside the one boundary that makes dlog total.
    const held = sinkFor(logPath());
    held.bytes += fs.writeSync(held.fd, line);
    if (held.bytes >= MAX_BYTES) {
      close();
      rotate(held.path);
    }
  } catch (e) {
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
        `${line}cc-candybar: daemon.log unwritable: ${(e as Error).message}\n`,
      );
    } catch {
      // stderr was the last channel.
    }
  }
}
