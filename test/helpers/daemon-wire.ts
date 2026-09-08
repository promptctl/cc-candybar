// [LAW:single-enforcer] The ONE daemon-socket request and the ONE child-exit await.

import type { ChildProcess } from "node:child_process";
import net from "node:net";

import { sendOne } from "../../src/daemon/protocol";
import type { Request, Response } from "../../src/daemon/protocol";

const DEFAULT_REPLY_BUDGET_MS = 5000;

// [LAW:one-source-of-truth] Connect, then delegate to protocol.ts's hardened `sendOne`.
export function sendDaemonRequest(
  sockPath: string,
  req: Record<string, unknown>,
  timeoutMs: number = DEFAULT_REPLY_BUDGET_MS,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    // [LAW:no-ambient-temporal-coupling] Budgets the connect phase, which sendOne does not.
    const connectTimer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
    // [LAW:locality-or-seam] Removed on the connect handoff, not left to sendOne's cleanup.
    const onConnectError = (err: Error): void => {
      clearTimeout(connectTimer);
      reject(err);
    };
    sock.once("error", onConnectError);
    sock.once("connect", () => {
      clearTimeout(connectTimer);
      sock.removeListener("error", onConnectError);
      sendOne(sock, req as unknown as Request, timeoutMs).then(
        resolve,
        reject,
      );
    });
  });
}

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

// [LAW:no-ambient-temporal-coupling] The pre-check closes the race where the child
// exited before `once("exit")` was registered; Node retains the terminal code.
export function waitForExit(child: ChildProcess): Promise<ExitResult> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
