// [LAW:single-enforcer] The ONE place that sends a single frame-encoded
// request to a daemon socket and awaits its response, and the ONE place
// that resolves a child process's actual exit — both were duplicated
// verbatim (byte-for-byte, modulo a timeout constant) across
// daemon-shutdown.test.ts (test/daemon-boots/process) and daemon-config-persistence-e2e.test.ts before
// this extraction (candybar-config-engine-71o.5 review). A protocol or
// socket-lifecycle change now has one call site to update, not N drifting
// copies.

import type { ChildProcess } from "node:child_process";

import type { RendererAddress, RendererHome } from "../../src/daemon/home";
import { logPath, socketPath } from "../../src/daemon/paths";
import { sendOne } from "../../src/daemon/protocol";
import { dialWithin, type Dialer } from "../../src/dial/dialer";
import { systemDialer } from "../../src/dial/system-dialer";
import type { Request, Response } from "../../src/daemon/protocol";
import { systemTimekeeper } from "../../src/time";

const DEFAULT_REPLY_BUDGET_MS = 5000;

// What a test reaches a daemon through: one request's round trip, the log the
// daemon writes, and the clock its clients state a deadline on. `req` stays
// loosely typed: the wire is untrusted JSON from the caller's perspective too.
export interface DaemonEndpoint {
  send(req: Record<string, unknown>, budgetMs: number): Promise<Response>;
  readonly log: string;
  // The renderer's name, which a link a test mints for it is addressed to, as
  // a home's `name` is for a real daemon.
  readonly name: RendererAddress;
  // [LAW:one-source-of-truth] A request's budget is its deadline less its
  // arrival, so the two are read off one clock: the machine's, for a real
  // daemon, and a daemon's own, for one a test holds the time of.
  now(): number;
}

// A daemon built in this worker is its own endpoint
// (test/helpers/in-worker-daemon.ts). A real one is named by its home, from
// which both the socket a test dials and the log it reads derive.
export type DaemonTarget = RendererHome | DaemonEndpoint;

// [LAW:single-enforcer] The one place a target is read, so nothing that retries
// or reads events knows which kind it was given.
export function endpointOf(target: DaemonTarget): DaemonEndpoint {
  return "kind" in target ? homeEndpoint(target, systemDialer) : target;
}

// The daemon a home names, reached through `dialer`: the machine's for a real
// one, or the fake a case's daemons listen on.
export function homeEndpoint(
  home: RendererHome,
  dialer: Dialer,
): DaemonEndpoint {
  const sockPath = socketPath(home);
  return {
    send: (req, budgetMs) => overDialer(dialer, sockPath, req, budgetMs),
    log: logPath(home),
    name: home.name,
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
async function overDialer(
  dialer: Dialer,
  sockPath: string,
  req: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  // [LAW:no-ambient-temporal-coupling] The connect has its own bound, which
  // sendOne (entered only once connected) does not budget for.
  const dialed = await dialWithin(
    dialer,
    sockPath,
    timeoutMs,
    systemTimekeeper,
  );
  if (!dialed.ok) {
    throw new Error(
      dialed.failure.cause === "timeout"
        ? `connect did not complete within ${timeoutMs}ms`
        : dialed.failure.message,
    );
  }
  return sendOne(
    dialed.conn,
    req as unknown as Request,
    Date.now() + timeoutMs,
    systemTimekeeper,
  );
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
    const exit = exitedAlready(child);
    if (exit !== null) {
      resolve(exit);
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

// [LAW:one-source-of-truth] The one synchronous read of a child's end, for the
// pre-check above and for a poll: one look per poll, so no `once("exit")`
// listener accumulates across iterations.
export function exitedAlready(child: ChildProcess): ExitResult | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { code: child.exitCode, signal: child.signalCode };
}

// [LAW:one-source-of-truth] THE probe for "is a daemon serving this socket":
// a connect that completes, then closed. A missing path errors the connect
// like a dead socket does, so there is no stat before it. A connect that
// neither completes nor errors (bound, nobody accepting) is destroyed at its
// own bound and answers false, so a poll that gives up on it leaves no live
// handle behind.
export async function isConnectable(sockPath: string): Promise<boolean> {
  const dialed = await dialWithin(
    systemDialer,
    sockPath,
    1_000,
    systemTimekeeper,
    {
      unref: true,
    },
  );
  if (dialed.ok) dialed.conn.destroy();
  return dialed.ok;
}
