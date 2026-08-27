import fs from "node:fs";
import path from "node:path";
import { logPath } from "./paths";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

let stream: fs.WriteStream | null = null;
let bytesWritten = 0;

function ensureStream(): fs.WriteStream {
  if (stream) return stream;
  const filePath = logPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Pre-load size so rotation triggers correctly across daemon restarts.
  try {
    bytesWritten = fs.statSync(filePath).size;
  } catch {
    bytesWritten = 0;
  }
  stream = fs.createWriteStream(filePath, { flags: "a" });
  return stream;
}

// Self-rotation: when daemon.log exceeds MAX_BYTES, shift .1→.2, .2→.3, drop
// the oldest, and start fresh. Daemon-internal so we don't depend on any
// external rotator. Cheap because rotation only runs at the rollover boundary.
function rotate(): void {
  const filePath = logPath();
  if (stream) {
    stream.end();
    stream = null;
  }
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
  bytesWritten = 0;
}

export type LogLevel = "info" | "warn" | "error";

// [LAW:locality-or-seam] The logging capability daemon components depend on.
// `dlog` is the daemon's implementation (writes to daemon.log); consumers that
// inject a different impl (a quiet default in tests) take this shape.
export type DaemonLogger = (level: LogLevel, msg: string) => void;

// [LAW:one-source-of-truth] Both emitters below render a line here, so a tail
// of daemon.log is uniformly parseable no matter which process wrote it.
function formatLine(level: LogLevel, msg: string): string {
  return `${new Date().toISOString()} [${level}] ${msg}\n`;
}

export function dlog(level: LogLevel, msg: string): void {
  const buf = Buffer.from(formatLine(level, msg), "utf8");
  const s = ensureStream();
  s.write(buf);
  bytesWritten += buf.length;
  if (bytesWritten >= MAX_BYTES) rotate();
}

// The same log file, written by a process that is not the daemon: `url-handle`
// runs for milliseconds under the URL-handler app, and its stderr goes nowhere
// an operator will ever read. Sharing one file is what makes a single `tail`
// show the whole click loop — the click leaving the client AND the daemon
// servicing it — which is the only way to tell a REJECTED click from one that
// never arrived.
//
// [LAW:single-enforcer] Rotation stays the daemon's job alone. It owns
// `bytesWritten` and the generation shuffle; a second rotator would rename
// files out from under the daemon's open stream. A client only ever appends,
// and O_APPEND makes one short line atomic against the daemon's concurrent
// writes.
export function clog(level: LogLevel, msg: string): void {
  const filePath = logPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, formatLine(level, msg));
}

export function closeLog(): void {
  if (stream) {
    stream.end();
    stream = null;
  }
}
