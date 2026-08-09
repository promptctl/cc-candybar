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

import { sendOne } from "../../src/daemon/protocol";
import type { Request, Response } from "../../src/daemon/protocol";

const DEFAULT_REPLY_BUDGET_MS = 5000;

// [LAW:one-source-of-truth] A thin connect-then-delegate wrapper around
// src/daemon/protocol.ts's own `sendOne` — the canonical, already-hardened
// single-frame-request implementation (settled guard + `removeAllListeners`
// on settle, so a `close` racing a just-arrived frame can never clobber an
// already-resolved response). An earlier version of this helper hand-rolled
// its own finish/timer/reader logic and reintroduced exactly the race
// `sendOne` was written to close — delegating instead of re-deriving is the
// fix, not patching the duplicate to match. `req` stays loosely typed (the
// wire is untrusted JSON from the caller's perspective too) and is narrowed
// at this one boundary, mirroring how the daemon's own request handler
// treats incoming JSON.
export function sendDaemonRequest(
  sockPath: string,
  req: Record<string, unknown>,
  timeoutMs: number = DEFAULT_REPLY_BUDGET_MS,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    sock.once("error", reject);
    sock.once("connect", () => {
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
