import fs from "node:fs";
import path from "node:path";
import { logPath } from "./paths";

export const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

// [LAW:no-ambient-temporal-coupling] Every line is a synchronous append, so a
// line is on disk the moment the call returns — including the death line each
// shutdown path writes last, which an async stream dropped whenever
// `process.exit` outran its flush. The daemon writes a handful of short lines
// per second; a sync append is microseconds. No stream means nothing to flush,
// nothing to close, and no window in which a late writer can reopen a sink
// that nobody waits for. [LAW:polishing-by-subtraction]
let bytesWritten: number | null = null;

// Pre-load size once so rotation triggers correctly across daemon restarts.
function currentBytes(filePath: string): number {
  if (bytesWritten !== null) return bytesWritten;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    bytesWritten = fs.statSync(filePath).size;
  } catch {
    bytesWritten = 0;
  }
  return bytesWritten;
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
  bytesWritten = 0;
}

export type LogLevel = "info" | "warn" | "error";

// [LAW:locality-or-seam] The logging capability daemon components depend on.
// `dlog` is the daemon's implementation (writes to daemon.log); consumers that
// inject a different impl (a quiet default in tests) take this shape.
export type DaemonLogger = (level: LogLevel, msg: string) => void;

export function dlog(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  try {
    // [LAW:single-enforcer] Path resolution reaches os.homedir(); it lives
    // inside the one boundary that makes dlog total.
    const filePath = logPath();
    const before = currentBytes(filePath);
    fs.appendFileSync(filePath, line);
    bytesWritten = before + Buffer.byteLength(line, "utf8");
    if (bytesWritten >= MAX_BYTES) rotate(filePath);
  } catch (e) {
    // [LAW:no-silent-failure] exception: the failure IS the log sink, so it
    // cannot be reported through the log sink. A throw here would escape the
    // crash handlers that call dlog first (uncaughtException → dlog →
    // shutdown), taking the clean-death path down with it. stderr carries the
    // line and the reason — the terminal when the daemon runs by hand, and
    // /dev/null under a detached spawn; the daemon keeps serving either way.
    // Nulling the counter re-runs the lazy init on the next call, so a state
    // dir removed out from under the daemon is recreated for the next line.
    bytesWritten = null;
    try {
      process.stderr.write(
        `${line}cc-candybar: daemon.log unwritable: ${(e as Error).message}\n`,
      );
    } catch {
      // stderr was the last channel.
    }
  }
}
