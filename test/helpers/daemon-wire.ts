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
import path from "node:path";

import { logPath } from "../../src/daemon/paths";
import { sendOne } from "../../src/daemon/protocol";
import type { Request, Response } from "../../src/daemon/protocol";

const DEFAULT_REPLY_BUDGET_MS = 5000;

// What a test reaches a daemon through: one request's round trip, the log the
// daemon writes, and the clock its clients state a deadline on. `req` stays
// loosely typed: the wire is untrusted JSON from the caller's perspective too.
export interface DaemonEndpoint {
  send(req: Record<string, unknown>, budgetMs: number): Promise<Response>;
  readonly log: string;
  // [LAW:one-source-of-truth] A request's budget is its deadline less its
  // arrival, so the two are read off one clock: the machine's, for a real
  // daemon, and a daemon's own, for one a test holds the time of.
  now(): number;
}

// A daemon built in this worker is its own endpoint
// (test/helpers/in-worker-daemon.ts). A real one is named by its socket path,
// because the socket is what a test of the process is about.
export type DaemonTarget = string | DaemonEndpoint;

// [LAW:single-enforcer] The one place a target is read, so nothing that retries
// or reads events knows which kind it was given.
export function endpointOf(target: DaemonTarget): DaemonEndpoint {
  if (typeof target !== "string") return target;
  return {
    send: (req, budgetMs) => overSocket(target, req, budgetMs),
    // An isolated daemon keeps its socket in its state directory
    // (prepareIsolatedDaemonEnv), whose log is the one the daemon itself
    // writes (logPath).
    log: logPath({ XDG_STATE_HOME: path.dirname(path.dirname(target)) }),
    now: Date.now,
  };
}

export function sendDaemonRequest(
  target: DaemonTarget,
  req: Record<string, unknown>,
  timeoutMs: number = DEFAULT_REPLY_BUDGET_MS,
): Promise<Response> {
  return endpointOf(target).send(req, timeoutMs);
}

// [LAW:one-source-of-truth] A thin connect-then-delegate wrapper around
// src/daemon/protocol.ts's own `sendOne` — the canonical, already-hardened
// single-frame-request implementation (a settled guard, so a `close` racing a
// just-arrived frame can never clobber an already-resolved response). An
// earlier version of this helper hand-rolled its own finish/timer/reader logic
// and reintroduced exactly the race `sendOne` was written to close — delegating
// instead of re-deriving is the fix, not patching the duplicate to match. `req`
// is narrowed at this one boundary, mirroring how the daemon's own request
// handler treats incoming JSON.
function overSocket(
  sockPath: string,
  req: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    // [LAW:no-ambient-temporal-coupling] Covers the connect phase, which
    // sendOne (entered only after "connect") does not budget for — a hung
    // connect() would otherwise wait forever with neither "error" nor
    // "connect" firing.
    const connectTimer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
    // [LAW:locality-or-seam] Owned and removed by this wrapper on the
    // connect handoff below: `sendOne` removes only the listeners it added.
    const onConnectError = (err: Error): void => {
      clearTimeout(connectTimer);
      reject(err);
    };
    sock.once("error", onConnectError);
    sock.once("connect", () => {
      clearTimeout(connectTimer);
      sock.removeListener("error", onConnectError);
      sendOne(sock, req as unknown as Request, Date.now() + timeoutMs).then(
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

// [LAW:one-source-of-truth] THE probe for "is a daemon serving this socket":
// a connect that completes, then closed. A missing path errors the connect
// like a dead socket does, so there is no stat before it. A connect that
// neither completes nor errors (bound, nobody accepting) is destroyed at its
// own bound and answers false, so a poll that gives up on it leaves no live
// handle behind.
export function isConnectable(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    sock.setTimeout(1_000, () => sock.destroy());
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("close", () => resolve(false));
  });
}
