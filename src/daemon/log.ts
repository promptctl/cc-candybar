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

export function dlog(level: "info" | "warn" | "error", msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  const buf = Buffer.from(line, "utf8");
  const s = ensureStream();
  s.write(buf);
  bytesWritten += buf.length;
  if (bytesWritten >= MAX_BYTES) rotate();
}

export function closeLog(): void {
  if (stream) {
    stream.end();
    stream = null;
  }
}
