export function debug(message: string, ...args: unknown[]): void {
  if (process.env.CC_CANDYBAR_DEBUG) {
    console.error(`[DEBUG] ${message}`, ...args);
  }
}

export type LogLevel = "info" | "warn" | "error";

// [LAW:locality-or-seam] The logging capability daemon components depend on,
// here below the daemon so a util or segment can take one without importing
// the daemon ([LAW:one-way-deps]). `dlog` (daemon/log) is the daemon's implementation (writes to daemon.log); consumers that
// inject a different impl (a quiet default in tests) take this shape.
export type DaemonLogger = (level: LogLevel, msg: string) => void;

// What every component logs through when its caller injects no sink: silent
// unless CC_CANDYBAR_DEBUG is set, and never daemon.log — only the daemon
// passes `dlog`.
export const quietLogger: DaemonLogger = (_level, message) => debug(message);
