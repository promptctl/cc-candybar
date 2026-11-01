import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pidAlive, PARENT_PID_ENV } from "../src/daemon/parent-watchdog";
import { spawnTestDaemon } from "./helpers/spawn-test-daemon";
import { until } from "./helpers/until";

// [LAW:verifiable-goals] End-to-end proof of the acceptance criterion in
// miniature: a REAL daemon process anchored to a throwaway "spawner" exits on
// its own when that spawner is SIGKILLed — no teardown hook involved, the same
// gap a killed Jest leaves. One controlled daemon, asserted dead, and force-
// reaped in afterEach so this test can never itself contribute to the leak.
describe("daemon dies with its spawner (integration)", () => {
  const spawned: ChildProcess[] = [];
  const tmpDirs: string[] = [];
  const releases: Array<() => void> = [];
  const killTrees: Array<() => void> = [];

  const track = (c: ChildProcess): ChildProcess => {
    spawned.push(c);
    return c;
  };
  const tmp = (prefix: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    // killTree first — it signals the daemon's WHOLE process group (the
    // `tsx` wrapper AND the worker process it forks, which does the real
    // daemon work and would otherwise survive as an orphan if only the
    // wrapper were signalled). Safe to call even after a graceful exit.
    for (const killTree of killTrees) killTree();
    killTrees.length = 0;
    for (const c of spawned) {
      if (c.exitCode === null && c.signalCode === null) {
        try {
          c.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    spawned.length = 0;
    for (const release of releases) release();
    releases.length = 0;
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    tmpDirs.length = 0;
  });

  test("SIGKILLing the anchor process shuts the daemon down", async () => {
    // A throwaway "spawner": stays alive until we kill it.
    const anchorProc = track(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
        stdio: "ignore",
      }),
    );

    const stateRoot = tmp("cc-candybar-watchdog-");
    const stateDir = path.join(stateRoot, "cc-candybar");
    // Bind-time trust precondition: socket parent must be uid==me + mode 0700.
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const sockPath = path.join(stateDir, "socket");

    const { child: daemonChild, killTree, release } = await spawnTestDaemon({
      ...process.env,
      CC_CANDYBAR_SOCKET: sockPath,
      XDG_STATE_HOME: stateRoot,
      XDG_CACHE_HOME: tmp("cc-candybar-watchdog-cache-"),
      XDG_CONFIG_HOME: tmp("cc-candybar-watchdog-config-"),
      // Anchor the daemon to the throwaway process, NOT this Jest worker, so
      // killing the anchor (and only the anchor) exercises the watchdog.
      [PARENT_PID_ENV]: String(anchorProc.pid),
    });
    releases.push(release);
    killTrees.push(killTree);
    const daemon = track(daemonChild);

    // The socket file appears inside bind(), which runs strictly AFTER the
    // watchdog is armed — so its existence guarantees the watchdog is live.
    await until(() => fs.existsSync(sockPath), "the daemon's socket");
    expect(daemon.exitCode).toBeNull();

    const daemonExited = new Promise<void>((resolve) =>
      daemon.once("exit", () => resolve()),
    );

    anchorProc.kill("SIGKILL");

    // Poll interval is 250ms + a 500ms shutdown backstop; 8s is a generous
    // ceiling. Clear the deadline timer once the daemon exits so it can't
    // outlive the test and hold Jest's event loop open.
    let deadline: NodeJS.Timeout | undefined;
    const exitedInTime = await Promise.race([
      daemonExited.then(() => true),
      new Promise<boolean>((r) => {
        deadline = setTimeout(() => r(false), 8000);
      }),
    ]);
    clearTimeout(deadline);

    expect(exitedInTime).toBe(true);
    expect(pidAlive(daemon.pid!)).toBe(false);
  }, 20000);
});
