import { render, killAndWait } from "../../helpers/daemon-e2e";
import { loggedLines } from "../../helpers/daemon-log";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

// [LAW:verifiable-goals] The daemon's renderer is a process of its own: one
// killed under it is started again, and answers the next request, and one
// whose daemon ended goes with it, its stdin closed under it.

// Each renderer's line as it came up, in the order they did.
const ups = (lines: readonly string[]): string[] =>
  lines.filter((l) => l.includes(" renderer up generation="));

const pidOf = (up: string): number => Number(/ pid=(\d+)/.exec(up)![1]);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the renderer's process", () => {
  jest.setTimeout(30_000);

  test("one killed is started again and answers, and none outlives its daemon", async () => {
    const { env, sockPath, stateDir, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-renderer",
    );
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      await render(sockPath, "renderer-a", stateDir);
      const [first] = await loggedLines(
        env,
        ups,
        (picked) => picked.length === 1,
        "the first renderer up",
      );
      process.kill(pidOf(first!), "SIGKILL");
      await loggedLines(
        env,
        (lines) =>
          lines.filter((l) => l.includes("renderer end generation=1 ")),
        (picked) => picked.length === 1,
        "the first renderer's end",
      );

      // [LAW:no-silent-failure] One that ended young starts again after its
      // backoff, and a request meanwhile fails saying why.
      await until(
        () =>
          render(sockPath, "renderer-a", stateDir).then(
            () => true,
            (e: Error) => {
              expect(e.message).toContain("no renderer runs");
              return false;
            },
          ),
        "a request answered by a restarted renderer",
      );
      const started = await loggedLines(
        env,
        (lines) =>
          lines.filter((l) => l.includes("renderer start generation=")),
        (picked) => picked.length === 2,
        "the restarted renderer's start",
      );
      expect(started[1]).toContain(" cause=crashed ");
      expect(started[1]).toContain(" sessions=1 ");
      const up = await loggedLines(
        env,
        ups,
        (picked) => picked.length === 2,
        "the restarted renderer up",
      );
      const second = pidOf(up[1]!);
      expect(alive(second)).toBe(true);

      await killAndWait(daemon, "SIGTERM");
      await until(() => !alive(second), "the renderer gone with its daemon");
    } finally {
      daemon?.killTree();
      removeTmpDirs();
    }
  });
});
