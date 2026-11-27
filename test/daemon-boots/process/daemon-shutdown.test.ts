import type { ChildProcess } from "node:child_process";
import { hostOf } from "../../../scripts/lib/host";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  effectsUrl,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
} from "../../../src/click/wire";
import { sessionStatePath } from "../../../src/daemon/paths";
import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { click, render, drawnLink } from "../../helpers/daemon-e2e";
import { sendClick } from "../../../scripts/lib/daemon/requests";
import {
  type IsolatedDaemonHandle,
  type RunningDaemon,
} from "../../../scripts/lib/daemon/isolated";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  spawnIsolatedDaemon,
} from "../../helpers/spawn-isolated-daemon";
import {
  sendDaemonRequest,
  waitForExit,
} from "../../../scripts/lib/daemon/wire";

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

async function spawnDaemon(): Promise<IsolatedDaemonHandle> {
  return spawnIsolatedDaemon("cc-candybar-shutdown");
}

// [LAW:verifiable-goals] Per-call timeout (not relying on Jest's global) so a
// hung daemon produces a focused failure with the right message, not a 30s
// global-timeout aborting the whole suite. The budget matches the contract:
// the test's outer guarantee is "process exits within SHUTDOWN_BUDGET_MS";
// the response round-trip is part of that envelope, so REPLY_BUDGET_MS uses
// the same number rather than a separate magic number.
const REPLY_BUDGET_MS = SHUTDOWN_BUDGET_MS;

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
      // connection.ts). Receiving the frame at all proves flush-before-exit —
      // a premature exit kills the socket frameless. The contract under
      // test is ALSO the *process exit*, not just the response — the
      // 452-corpse incident produced responses but never produced exits.
      const resp = await sendDaemonRequest(
        handle.sockPath,
        { v: PROTOCOL_VERSION, kind: "shutdown" },
        REPLY_BUDGET_MS,
      );
      expect(resp).toEqual({ ok: true, output: "" });
      await expectExitWithinBudget(handle.child);
    } finally {
      await handle.cleanup();
    }
  });

  test("a newer client gets VERSION_MISMATCH and the host stays up", async () => {
    const handle = await spawnDaemon();
    try {
      // [LAW:one-source-of-truth] Only the install's record and the running
      // bundle's own file move the host to other code. A client ahead of the
      // installed protocol (a worktree's build) must not end the host that
      // every other bar draws from: the next request is answered by the same
      // process.
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
      const next = await sendDaemonRequest(
        handle.sockPath,
        { v: PROTOCOL_VERSION, kind: "stats" },
        REPLY_BUDGET_MS,
      );
      expect(next.ok).toBe(true);
    } finally {
      await handle.cleanup();
    }
  });

  // The running host journals a click before replying. SIGTERM additionally
  // publishes the legacy JSON a pinned previous release will read.
  test("SIGTERM exports an already journaled session write before the daemon exits", async () => {
    const { env, sockPath, stateDir, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-shutdown",
    );
    const sessionId = "shutdown-write";
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      await render(sockPath, sessionId, stateDir);
      await click(
        sockPath,
        drawnLink(
          sockPath,
          effectsUrl([
            { verb: VERB_SET_STATE, args: [sessionId, "padding", "4"] },
          ]),
        ),
      );
      const file = sessionStatePath(hostOf(env));
      expect(
        readFileSync(
          path.join(path.dirname(file), "shared-session", "changes"),
          "utf8",
        ),
      ).toContain(sessionId);
      expect(existsSync(file)).toBe(false);
      expect(await daemon.stop("SIGTERM")).toEqual({ code: 0, signal: null });

      const saved = JSON.parse(
        readFileSync(sessionStatePath(hostOf(env)), "utf8"),
      );
      expect(saved[sessionId]).toMatchObject({ padding: "4" });
    } finally {
      await daemon?.stop();
      removeTmpDirs();
    }
  });

  test("two socket paths cannot acquire the same state directory, and a successor can recover after SIGKILL", async () => {
    const first = prepareIsolatedDaemonEnv("ccb-state-owner");
    const second = prepareIsolatedDaemonEnv("ccb-state-peer");
    const peerEnv = { ...first.env, CC_CANDYBAR_SOCKET: second.sockPath };
    const file = sessionStatePath(hostOf(first.env));
    const journal = path.join(path.dirname(file), "shared-session", "changes");
    let owner: RunningDaemon | undefined;
    let successor: RunningDaemon | undefined;
    try {
      owner = await spawnDaemonWithEnv(first.env);
      const sid = "surviving-owner";
      await render(first.sockPath, sid, first.stateDir);
      await click(
        first.sockPath,
        drawnLink(
          first.sockPath,
          effectsUrl([{ verb: VERB_SET_STATE, args: [sid, "padding", "3"] }]),
        ),
      );
      const committed = readFileSync(journal);
      await expect(spawnDaemonWithEnv(peerEnv)).rejects.toThrow(
        new RegExp("session state at .* is in use by pid=" + owner.child.pid),
      );
      expect(readFileSync(journal)).toEqual(committed);
      expect(existsSync(file)).toBe(false);
      const stats = await sendDaemonRequest(
        first.sockPath,
        {
          v: PROTOCOL_VERSION,
          kind: "stats",
        },
        REPLY_BUDGET_MS,
      );
      expect(stats.ok).toBe(true);
      expect(await owner.stop("SIGKILL")).toEqual({
        code: null,
        signal: "SIGKILL",
      });
      successor = await spawnDaemonWithEnv(peerEnv);
      expect(await successor.stop("SIGTERM")).toEqual({
        code: 0,
        signal: null,
      });
      expect(JSON.parse(readFileSync(file, "utf8"))[sid]).toEqual({
        padding: "3",
      });
    } finally {
      await successor?.stop();
      await owner?.stop();
      second.removeTmpDirs();
      first.removeTmpDirs();
    }
  });

  test("an unsuccessful legacy export exits nonzero and the next host finishes the handoff", async () => {
    const isolated = prepareIsolatedDaemonEnv("ccb-export-retry");
    const { env, sockPath, stateDir } = isolated;
    const file = sessionStatePath(hostOf(env));
    const sid = "interrupted-export";
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      await render(sockPath, sid, stateDir);
      await click(
        sockPath,
        drawnLink(
          sockPath,
          effectsUrl([{ verb: VERB_SET_STATE, args: [sid, "padding", "4"] }]),
        ),
      );
      mkdirSync(file);
      expect(await daemon.stop("SIGTERM")).toEqual({ code: 1, signal: null });
      rmdirSync(file);
      daemon = await spawnDaemonWithEnv(env);
      expect(await daemon.stop("SIGTERM")).toEqual({ code: 0, signal: null });
      expect(JSON.parse(readFileSync(file, "utf8"))[sid]).toEqual({
        padding: "4",
      });
    } finally {
      await daemon?.stop();
      isolated.removeTmpDirs();
    }
  });

  test.each([
    ["session pick", VERB_SET_STATE, ["padding", "4"]],
    [
      "config file with an undo step",
      VERB_SET_CONFIG,
      ["user", "palette", "nord"],
    ],
  ] as const)(
    "a refused journal write reaches the caller of a %s click",
    async (_label, verb, args) => {
      const { env, sockPath, stateDir, removeTmpDirs } =
        prepareIsolatedDaemonEnv("ccb-refused-write");
      const root = path.dirname(sessionStatePath(hostOf(env)));
      const journal = path.join(root, "shared-session", "changes");
      const sid = "refused-commit";
      let daemon: RunningDaemon | undefined;
      try {
        const config = path.join(stateDir, "settings.json5");
        writeFileSync(
          config,
          JSON.stringify({
            actions: { pal: { persist: "palette", from: "themes" } },
            segments: {
              choice: { template: '{{ action "pal" "palette" "nord" }}' },
            },
            root: { h: ["choice"] },
          }),
        );
        daemon = await spawnDaemonWithEnv(env);
        await render(sockPath, sid, stateDir, {}, [
          "node",
          "--config-only",
          config,
        ]);
        mkdirSync(journal);
        const response = await sendClick(
          sockPath,
          drawnLink(sockPath, effectsUrl([{ verb, args: [sid, ...args] }])),
        );
        expect(response).toMatchObject({
          ok: false,
          code: "RENDER_FAILED",
          error: expect.stringContaining("session journal"),
        });
        rmdirSync(journal);
        expect(await daemon.stop("SIGTERM")).toEqual({ code: 0, signal: null });
        const saved = JSON.parse(
          readFileSync(path.join(root, "settings-history.json"), "utf8"),
        );
        expect(saved[sid].past).toHaveLength(1);
      } finally {
        await daemon?.stop();
        removeTmpDirs();
      }
    },
  );
});
