// [LAW:behavior-not-structure] What a daemon laid out on a real tmux server is
// put back when it shuts down: the at-exit handle's synchronous tmux calls
// finish before the process does.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { configFlag, killAndWait, render } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "./helpers/spawn-isolated-daemon";
import { until } from "./helpers/until";

const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;

(HAS_TMUX ? test : test.skip)(
  "shutdown restores a session's tmux status options",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-restore-"));
    const socket = path.join(dir, "tmux.sock");
    const tmux = (...args: string[]): string => {
      const run = spawnSync("tmux", ["-S", socket, ...args], {
        encoding: "utf8",
      });
      if (run.status !== 0) throw new Error(`tmux ${args[0]}: ${run.stderr}`);
      return run.stdout;
    };
    const { env, sockPath, removeTmpDirs } =
      prepareIsolatedDaemonEnv("ccb-tmux-restore");
    const config = path.join(dir, "tmux.json5");
    writeFileSync(
      config,
      `{ globals: { renderer: "tmux" }, segments: { mark: { template: 'a mark' } }, root: { h: ['mark'] } }`,
    );
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "bar", "-x", "120", "-y", "40");
    const daemon = await spawnDaemonWithEnv(env);
    try {
      const pane = tmux("list-panes", "-t", "bar", "-F", "#{pane_id}").trim();
      const own = (): string => tmux("show-options", "-t", "bar");
      const before = own();

      const draw = (): Promise<unknown> =>
        render(
          sockPath,
          "tmux-restore",
          dir,
          {
            termCols: 120,
            termRows: 40,
            tmux: { socket, pane, truecolor: null },
          },
          configFlag(config),
        );
      await until(async () => {
        await draw();
        return own() !== before;
      }, "the daemon's layout on the session");

      await killAndWait(daemon, "SIGTERM");
      expect(own()).toBe(before);
    } finally {
      daemon.killTree();
      // The private server's one session: tmux exits with its last.
      spawnSync("tmux", ["-S", socket, "kill-session", "-t", "bar"]);
      removeTmpDirs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
