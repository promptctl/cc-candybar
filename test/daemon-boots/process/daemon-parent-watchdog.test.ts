import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import { untilTestEnds } from "../../helpers/test-end";
import { PARENT_PID_ENV } from "../../../src/daemon/parent-watchdog";
import { prepareIsolatedDaemonEnv, spawnDaemonWithEnv } from "../../helpers/spawn-isolated-daemon";
import type { RunningDaemon } from "../../../scripts/lib/daemon/isolated";

// [LAW:verifiable-goals] End-to-end proof of the acceptance criterion in
// miniature: a REAL daemon process anchored to a throwaway "spawner" exits on
// its own when that spawner is SIGKILLed — no teardown hook involved, the same
// gap a killed Jest leaves. One controlled daemon, asserted dead, and force-
// reaped in afterEach so this test can never itself contribute to the leak.
describe("daemon dies with its spawner (integration)", () => {
  let anchor: ChildProcess;
  let daemon: RunningDaemon | undefined;
  let removeTmpDirs: () => void;

  afterEach(async () => {
    try {
      await daemon?.stop();
    } finally {
      if (anchor.exitCode === null && anchor.signalCode === null) anchor.kill("SIGKILL");
      removeTmpDirs();
    }
  });

  test("SIGKILLing the anchor process shuts the daemon down", async () => {
    const isolated = prepareIsolatedDaemonEnv("ccb-watchdog");
    removeTmpDirs = isolated.removeTmpDirs;
    anchor = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await once(anchor, "spawn");
    // The shared readiness contract has received a stats reply from this daemon.
    daemon = await spawnDaemonWithEnv({
      ...isolated.env,
      [PARENT_PID_ENV]: String(anchor.pid),
    });
    const anchorExit = once(anchor, "exit");
    const child = daemon.child;
    const daemonExit = untilTestEnds(
      (signal) => once(child, "exit", { signal }),
      `daemon ${child.pid} to exit after its spawner ${anchor.pid} was killed`,
    );
    expect(anchor.kill("SIGKILL")).toBe(true);
    expect(await anchorExit).toEqual([null, "SIGKILL"]);
    expect(await daemonExit).toEqual([0, null]);
  });
});
