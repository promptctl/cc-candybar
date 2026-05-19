import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "../src/daemon/protocol";
import type { Response } from "../src/daemon/protocol";

// [LAW:verifiable-goals] Contract: a daemon that receives a `shutdown` request
// MUST exit within a bounded wall-clock budget. The bound has to be tight
// enough that the singleton-mutex invariant (the bound socket FD is released)
// is observable mechanically, not just "eventually". 1500ms is a generous
// ceiling that swallows Node startup latency on slow CI; the actual guarantee
// inside `shutdown()` is the 500ms SIGKILL backstop. This invariant is what
// the 452-corpse incident violated — daemons logged "shutting down" but held
// the socket FD 42 minutes later, so the invariant cannot be "process.exit
// was reached" — it has to be "process is gone".

// jest's rootDir is the repo root; resolve everything relative to it.
const REPO_ROOT = process.cwd();
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

const SHUTDOWN_BUDGET_MS = 1500;

interface DaemonHandle {
  child: ChildProcess;
  sockPath: string;
  stateDir: string;
  cleanup(): void;
}

async function spawnDaemon(): Promise<DaemonHandle> {
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cc-candybar-shutdown-"),
  );
  const stateDir = path.join(stateRoot, "cc-candybar");
  fs.mkdirSync(stateDir, { recursive: true });
  const sockPath = path.join(stateDir, "socket");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_STATE_HOME: stateRoot,
    // Isolate cache + config so the test daemon doesn't see the developer's
    // real state. Each gets its own tempdir.
    XDG_CACHE_HOME: fs.mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-shutdown-cache-"),
    ),
    XDG_CONFIG_HOME: fs.mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-shutdown-config-"),
    ),
  };

  const child = spawn(TSX_BIN, [ENTRY, "daemon"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Drain stdio so the child's pipes don't fill and stall.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  // [LAW:verifiable-goals] The readiness check has to assert the *load-bearing*
  // property — the daemon actually serves connections — not a proxy that can
  // hold while the property doesn't. The socket file appears synchronously
  // inside bind(), but bind() succeeding doesn't prove the accept() loop is
  // running. A successful connect() round-trip does. If we let "file exists"
  // pass as readiness, a daemon that bound but hung before accepting would
  // let the test proceed and hang downstream on its first request.
  const deadline = Date.now() + 5000;
  let alive = false;
  while (!alive && Date.now() < deadline) {
    if (fs.existsSync(sockPath)) {
      alive = await new Promise<boolean>((resolve) => {
        const s = net.connect(sockPath);
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => resolve(false));
      });
    }
    if (!alive) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  if (!alive) {
    child.kill("SIGKILL");
    throw new Error(
      "daemon did not accept connections within 5000ms (socket file" +
        ` ${fs.existsSync(sockPath) ? "exists" : "absent"})`,
    );
  }

  return {
    child,
    sockPath,
    stateDir,
    cleanup: () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      try {
        fs.rmSync(stateRoot, { recursive: true, force: true });
      } catch {}
      if (env.XDG_CACHE_HOME) {
        try {
          fs.rmSync(env.XDG_CACHE_HOME, { recursive: true, force: true });
        } catch {}
      }
      if (env.XDG_CONFIG_HOME) {
        try {
          fs.rmSync(env.XDG_CONFIG_HOME, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}

// [LAW:verifiable-goals] Per-call timeout (not relying on Jest's global) so a
// hung daemon produces a focused failure with the right message, not a 30s
// global-timeout aborting the whole suite. The budget matches the contract:
// the test's outer guarantee is "process exits within SHUTDOWN_BUDGET_MS";
// the response round-trip is part of that envelope, so REPLY_BUDGET_MS uses
// the same number rather than a separate magic number.
const REPLY_BUDGET_MS = SHUTDOWN_BUDGET_MS;

function sendShutdown(sockPath: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(
        new Error(
          `shutdown response did not arrive within ${REPLY_BUDGET_MS}ms`,
        ),
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
      sock.write(encodeFrame({ v: PROTOCOL_VERSION, kind: "shutdown" }));
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

describe("daemon shutdown contract", () => {
  // The shutdown path involves spawning Node via tsx and binding a Unix
  // socket; 30s is the project-wide jest default and is plenty even on a
  // cold machine.
  jest.setTimeout(30_000);

  test("daemon exits within budget after a shutdown request", async () => {
    const handle = await spawnDaemon();
    try {
      // Send the shutdown request. The daemon responds with ok:true then
      // schedules `shutdown(0)` 50ms later (see handleRequest). The
      // contract under test is the *process exit*, not the response — the
      // 452-corpse incident produced responses but never produced exits.
      const resp = await sendShutdown(handle.sockPath);
      expect(resp).toEqual({ ok: true, output: "" });

      // [LAW:verifiable-goals] The budget is enforced by the timer below:
      // if the daemon hasn't exited within SHUTDOWN_BUDGET_MS, Promise.race
      // rejects with a focused error. A separate `expect(elapsed < BUDGET)`
      // check on the resolved path would be redundant AND flaky — Date.now()
      // is ms-granularity and includes post-exit scheduling overhead, so a
      // run that exited just under budget can read as exactly the budget.
      // The timer is the contract; no further wall-clock assertion is added.
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const { code, signal } = await Promise.race([
        waitForExit(handle.child).then((r) => {
          if (budgetTimer) clearTimeout(budgetTimer);
          return r;
        }),
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (_, reject) => {
            budgetTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    `daemon did not exit within ${SHUTDOWN_BUDGET_MS}ms`,
                  ),
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
    } finally {
      handle.cleanup();
    }
  });
});
