import { spawn, type ChildProcess } from "node:child_process";

import { logLines } from "../../../src/daemon/log";
import { PARENT_PID_ENV } from "../../../src/daemon/parent-watchdog";
import { logPath } from "../../../src/daemon/paths";
import { systemSpawner } from "../../../src/proc/spawner";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

// [LAW:verifiable-goals] End-to-end proof of the acceptance criterion in
// miniature: a REAL daemon process anchored to a throwaway "spawner" exits on
// its own when that spawner is SIGKILLed — no teardown hook involved, the same
// gap a killed Jest leaves. One controlled daemon, asserted dead, and force-
// reaped in afterEach so this test can never itself contribute to the leak.
describe("daemon dies with its spawner (integration)", () => {
  const spawned: ChildProcess[] = [];
  const cleanups: Array<() => void> = [];
  const killTrees: Array<() => void> = [];

  const track = (c: ChildProcess): ChildProcess => {
    spawned.push(c);
    return c;
  };

  afterEach(() => {
    // killTree first — it signals the daemon's WHOLE process group (the
    // `tsx` wrapper AND the worker process it forks, which does the real
    // daemon work and would otherwise survive as an orphan if only the
    // wrapper were signalled) and releases its pool slot. Safe to call even
    // after a graceful exit.
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
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  test("SIGKILLing the anchor process shuts the daemon down", async () => {
    // A throwaway "spawner": stays alive until we kill it.
    const anchorProc = track(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
        stdio: "ignore",
      }),
    );

    const { env, home, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-watchdog");
    cleanups.push(removeTmpDirs);

    // [LAW:one-source-of-truth] The shared readiness: a daemon that answers a
    // round trip, under the one budget measured against a loaded machine's
    // boot. The answer comes after bind(), which runs strictly AFTER the
    // watchdog is armed — so a ready daemon has a live watchdog.
    const { child: daemonChild, killTree } = await spawnDaemonWithEnv({
      ...env,
      // Anchor the daemon to the throwaway process, NOT this Jest worker, so
      // killing the anchor (and only the anchor) exercises the watchdog.
      [PARENT_PID_ENV]: String(anchorProc.pid),
    });
    killTrees.push(killTree);
    const daemon = track(daemonChild);

    anchorProc.kill("SIGKILL");
    // Until this worker reaps it, the anchor is a zombie that still answers the
    // watchdog's kill(pid, 0); the daemon's budget starts once it is gone.
    await until(() => anchorProc.signalCode !== null, "the anchor's reap");

    // [LAW:no-ambient-temporal-coupling] The wait is on the daemon's own exit;
    // the budget bounds only a daemon that never exits. Its exit path compiles
    // nothing — a 250ms poll, then shutdown's 500ms backstop — so 8s is a
    // generous ceiling. The whole group is waited on, because the tsx worker
    // runs the watchdog and could outlive the wrapper as an orphan.
    await until(
      () => systemSpawner.groupGone(daemon.pid!),
      "the daemon's process group gone after its anchor was SIGKILLed",
      8_000,
    );
    // The watchdog, not some other death, ended it.
    expect(logLines(logPath(home))).toContainEqual(
      expect.stringMatching(/parent watchdog: spawner pid \d+ gone; shutting down/),
    );
  });
});
