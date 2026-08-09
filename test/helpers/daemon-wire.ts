// [LAW:single-enforcer] The ONE place that sends a single frame-encoded
// request to a daemon socket and awaits its response, and the ONE place
// that resolves a child process's actual exit — both were duplicated
// verbatim (byte-for-byte, modulo a timeout constant) across
// daemon-shutdown.test.ts and daemon-config-persistence-e2e.test.ts before
// this extraction (candybar-config-engine-71o.5 review). A protocol or
// socket-lifecycle change now has one call site to update, not N drifting
// copies.

import type { ChildProcess } from "node:child_process";
import net from "node:net";

import { encodeFrame, makeFrameReader } from "../../src/daemon/protocol";
import type { Response } from "../../src/daemon/protocol";

const DEFAULT_REPLY_BUDGET_MS = 5000;

// [LAW:no-silent-failure] Mirrors src/daemon/protocol.ts's own `sendOne`
// contract: a `close` with no prior frame (the daemon crashed after
// accepting the request but before writing a response) must reject
// immediately, not silently wait out the full timeout budget — a daemon
// crash mid-request would otherwise read as "slow", wasting the whole
// budget per call instead of failing fast with a diagnosable cause.
export function sendDaemonRequest(
  sockPath: string,
  req: Record<string, unknown>,
  timeoutMs: number = DEFAULT_REPLY_BUDGET_MS,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`daemon response did not arrive within ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (action: () => void): void => {
      clearTimeout(timer);
      sock.destroy();
      action();
    };
    const reader = makeFrameReader(
      (frame) => finish(() => resolve(frame as Response)),
      (err) => finish(() => reject(err)),
    );
    sock.on("data", reader);
    sock.once("error", (err) => finish(() => reject(err)));
    sock.once("close", () =>
      finish(() =>
        reject(new Error("daemon socket closed before a response arrived")),
      ),
    );
    sock.once("connect", () => {
      sock.write(encodeFrame(req));
    });
  });
}

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

// [LAW:no-ambient-temporal-coupling] The pre-check (`exitCode !== null ||
// signalCode !== null`) closes the race where the child already exited
// before this function's `once("exit", ...)` listener is registered — a
// listener attached after the event fired never fires, hanging the caller
// forever. Node's ChildProcess retains the terminal exit code/signal after
// the event, so checking it directly (rather than re-deriving from a
// stale "did I miss it" guess) is the correct, race-free source.
export function waitForExit(child: ChildProcess): Promise<ExitResult> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
