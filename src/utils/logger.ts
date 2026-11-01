// [LAW:one-source-of-truth] The debug channel's gate and its line shape, in
// one place: `debug` emits a line now; `debugText` hands the same line to a
// writer that delivers it itself (a one-shot command's plan), and is empty
// when the channel is off. The message is a thunk, so what it costs to
// compose (a byte count over a body) is paid only when the channel is on.
const debugOn = (): boolean => Boolean(process.env.CC_CANDYBAR_DEBUG);

export function debugText(message: () => string): string {
  return debugOn() ? `[DEBUG] ${message()}\n` : "";
}

export function debug(message: string, ...args: unknown[]): void {
  if (debugOn()) {
    console.error(`[DEBUG] ${message}`, ...args);
  }
}

export type LogLevel = "info" | "warn" | "error";

// [LAW:locality-or-seam] The logging capability daemon components depend on,
// here below the daemon so a util or segment can take one without importing
// the daemon ([LAW:one-way-deps]). `dlog` (daemon/log) is the daemon's implementation (writes to daemon.log); consumers that
// inject a different impl (a quiet default in tests) take this shape.
export type DaemonLogger = (level: LogLevel, msg: string) => void;

// [LAW:one-type-per-behavior] A log line that repeats only on change, one
// per channel — the steady state of a one-minute clock is silence.
export function changeLogger(
  log: DaemonLogger,
): (entry: [LogLevel, string]) => void {
  let last: string | null = null;
  return ([level, msg]) => {
    if (msg === last) return;
    last = msg;
    log(level, msg);
  };
}

// What every component logs through when its caller injects no sink: silent
// unless CC_CANDYBAR_DEBUG is set, and never daemon.log — only the daemon
// passes its log.
export const quietLogger: DaemonLogger = (_level, message) => debug(message);
