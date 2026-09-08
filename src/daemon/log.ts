import fs from "node:fs";
import path from "node:path";
import { logPath } from "./paths";

export const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

// [LAW:no-ambient-temporal-coupling] Synchronous appends, so the death line survives `process.exit`. [LAW:polishing-by-subtraction]
let bytesWritten: number | null = null;

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

export type DaemonLogger = (level: LogLevel, msg: string) => void;

export function dlog(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  try {
    // [LAW:single-enforcer] Path resolution reaches os.homedir(); this boundary makes dlog total.
    const filePath = logPath();
    const before = currentBytes(filePath);
    fs.appendFileSync(filePath, line);
    bytesWritten = before + Buffer.byteLength(line, "utf8");
    if (bytesWritten >= MAX_BYTES) rotate(filePath);
  } catch (e) {
    // [LAW:no-silent-failure] exception: the sink itself failed, so it cannot report
    // through itself; a throw would escape the crash handlers that call dlog first.
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
