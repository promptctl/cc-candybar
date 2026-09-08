import type { ChildProcess } from "node:child_process";

import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import {
  spawnIsolatedDaemon,
  type IsolatedDaemonHandle,
} from "./helpers/spawn-isolated-daemon";
import { sendDaemonRequest, waitForExit } from "./helpers/daemon-wire";

// [LAW:verifiable-goals] Contract: a `shutdown` request MUST make the process
// exit within a bounded wall-clock budget — "process is gone", not "exit was reached".

const SHUTDOWN_BUDGET_MS = 1500;

async function spawnDaemon(): Promise<IsolatedDaemonHandle> {
  return spawnIsolatedDaemon("cc-candybar-shutdown");
}

// [LAW:verifiable-goals] Per-call timeout so a hung daemon fails focused, not as a global-timeout abort.
const REPLY_BUDGET_MS = SHUTDOWN_BUDGET_MS;

// [LAW:verifiable-goals] The timer below IS the contract; a further `elapsed < BUDGET` assert would be flaky.
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
  // Either a clean exit or the SIGKILL backstop: the process being gone is the invariant.
  const ok = code === 0 || signal === "SIGKILL";
  expect(ok).toBe(true);
}

describe("daemon shutdown contract", () => {
  jest.setTimeout(30_000);

  test("daemon exits within budget after a shutdown request", async () => {
    const handle = await spawnDaemon();
    try {
      // Receiving the frame at all proves flush-before-exit; the contract is ALSO the process exit.
      const resp = await sendDaemonRequest(
        handle.sockPath,
        { v: PROTOCOL_VERSION, kind: "shutdown" },
        REPLY_BUDGET_MS,
      );
      expect(resp).toEqual({ ok: true, output: "" });
      await expectExitWithinBudget(handle.child);
    } finally {
      handle.cleanup();
    }
  });

  test("newer-client version mismatch: VERSION_MISMATCH is flushed before the daemon exits", async () => {
    const handle = await spawnDaemon();
    try {
      // [LAW:no-ambient-temporal-coupling] A client at v+1 must receive the flushed
      // VERSION_MISMATCH diagnostic, never the dead socket a frameless close would give.
      const resp = await sendDaemonRequest(
        handle.sockPath,
        { v: PROTOCOL_VERSION + 1, kind: "render" },
        REPLY_BUDGET_MS,
      );
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
