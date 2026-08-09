import type { ChildProcess } from "node:child_process";
import net from "node:net";

import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "../src/daemon/protocol";
import type { Response } from "../src/daemon/protocol";
import { spawnIsolatedDaemon } from "./helpers/spawn-isolated-daemon";

// [LAW:verifiable-goals] Contract: a daemon that receives a `shutdown` request
// MUST exit within a bounded wall-clock budget. The bound has to be tight
// enough that the singleton-mutex invariant (the bound socket FD is released)
// is observable mechanically, not just "eventually". 1500ms is a generous
// ceiling that swallows Node startup latency on slow CI; the actual guarantee
// inside `shutdown()` is the 500ms SIGKILL backstop. This invariant is what
// the 452-corpse incident violated — daemons logged "shutting down" but held
// the socket FD 42 minutes later, so the invariant cannot be "process.exit
// was reached" — it has to be "process is gone".

const SHUTDOWN_BUDGET_MS = 1500;

interface DaemonHandle {
  child: ChildProcess;
  sockPath: string;
  stateDir: string;
  cleanup(): void;
}

async function spawnDaemon(): Promise<DaemonHandle> {
  return spawnIsolatedDaemon("cc-candybar-shutdown");
}

// [LAW:verifiable-goals] Per-call timeout (not relying on Jest's global) so a
// hung daemon produces a focused failure with the right message, not a 30s
// global-timeout aborting the whole suite. The budget matches the contract:
// the test's outer guarantee is "process exits within SHUTDOWN_BUDGET_MS";
// the response round-trip is part of that envelope, so REPLY_BUDGET_MS uses
// the same number rather than a separate magic number.
const REPLY_BUDGET_MS = SHUTDOWN_BUDGET_MS;

function sendDaemonRequest(
  sockPath: string,
  req: Record<string, unknown>,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(
        new Error(`daemon response did not arrive within ${REPLY_BUDGET_MS}ms`),
      );
    }, REPLY_BUDGET_MS);
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
    sock.once("connect", () => {
      sock.write(encodeFrame(req));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

// [LAW:verifiable-goals] The budget is enforced by the timer below: if the
// daemon hasn't exited within SHUTDOWN_BUDGET_MS, Promise.race rejects with
// a focused error. A separate `expect(elapsed < BUDGET)` check on the
// resolved path would be redundant AND flaky — Date.now() is ms-granularity
// and includes post-exit scheduling overhead, so a run that exited just
// under budget can read as exactly the budget. The timer is the contract;
// no further wall-clock assertion is added.
async function expectExitWithinBudget(child: ChildProcess): Promise<void> {
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const { code, signal } = await Promise.race([
    waitForExit(child).then((r) => {
      if (budgetTimer) clearTimeout(budgetTimer);
      return r;
    }),
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (_, reject) => {
        budgetTimer = setTimeout(
          () =>
            reject(
              new Error(`daemon did not exit within ${SHUTDOWN_BUDGET_MS}ms`),
            ),
          SHUTDOWN_BUDGET_MS,
        );
      },
    ),
  ]);
  // Either a clean exit (code 0) or the SIGKILL backstop fired
  // (signal SIGKILL). Either way the process is gone, which is the
  // load-bearing invariant. Anything else (code !== 0 from a clean
  // exit, or a non-SIGKILL signal) is a regression worth surfacing.
  const ok = code === 0 || signal === "SIGKILL";
  expect(ok).toBe(true);
}

describe("daemon shutdown contract", () => {
  // The shutdown path involves spawning Node via tsx and binding a Unix
  // socket; 30s is the project-wide jest default and is plenty even on a
  // cold machine.
  jest.setTimeout(30_000);

  test("daemon exits within budget after a shutdown request", async () => {
    const handle = await spawnDaemon();
    try {
      // Send the shutdown request. The daemon writes ok:true and sequences
      // `shutdown(0)` on the response flush completion (see respond() in
      // server.ts). Receiving the frame at all proves flush-before-exit —
      // a premature exit kills the socket frameless. The contract under
      // test is ALSO the *process exit*, not just the response — the
      // 452-corpse incident produced responses but never produced exits.
      const resp = await sendDaemonRequest(handle.sockPath, {
        v: PROTOCOL_VERSION,
        kind: "shutdown",
      });
      expect(resp).toEqual({ ok: true, output: "" });
      await expectExitWithinBudget(handle.child);
    } finally {
      handle.cleanup();
    }
  });

  test("newer-client version mismatch: VERSION_MISMATCH is flushed before the daemon exits", async () => {
    const handle = await spawnDaemon();
    try {
      // [LAW:no-ambient-temporal-coupling] The race this pins: a client at
      // v+1 (binary upgraded under the daemon) must receive the flushed
      // VERSION_MISMATCH diagnostic, never a dead socket — the client-side
      // classification is permanent/version_mismatch, never the
      // transient/io_error a frameless close would produce. Then the stale
      // daemon must actually exit so the next render respawns fresh.
      const resp = await sendDaemonRequest(handle.sockPath, {
        v: PROTOCOL_VERSION + 1,
        kind: "render",
      });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("VERSION_MISMATCH");
        expect(resp.daemonV).toBe(PROTOCOL_VERSION);
      }
      await expectExitWithinBudget(handle.child);
    } finally {
      handle.cleanup();
    }
  });
});
