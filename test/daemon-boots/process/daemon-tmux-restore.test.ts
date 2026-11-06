// [LAW:behavior-not-structure] What a daemon laid out on a real tmux server is
// put back when it shuts down: the at-exit handle's synchronous tmux calls
// finish before the process does. While the row is drawn, the session names
// the renderer drawing it, and a daemon started after the restore names it
// again.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RENDERER_OPTION } from "../../../src/daemon/tmux-status";
import { configFlag, killAndWait, render } from "../../helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;

(HAS_TMUX ? test : test.skip)(
  "shutdown restores a session's tmux status options, and a restarted daemon names itself on the row again",
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
    const { env, home, sockPath, removeTmpDirs } =
      prepareIsolatedDaemonEnv("ccb-tmux-restore");
    const config = path.join(dir, "tmux.json5");
    writeFileSync(
      config,
      `{ globals: { renderer: "tmux" }, segments: { mark: { template: 'a mark' } }, root: { h: ['mark'] } }`,
    );
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "bar",
      "-x",
      "120",
      "-y",
      "40",
    );
    try {
      const pane = tmux("list-panes", "-t", "bar", "-F", "#{pane_id}").trim();
      const own = (): string => tmux("show-options", "-t", "bar");
      const renderer = (): string =>
        tmux("show-options", "-q", "-v", "-t", "bar", RENDERER_OPTION).trim();
      const before = own();
      const draw = (): Promise<unknown> =>
        render(
          home,
          "tmux-restore",
          dir,
          {
            termCols: 120,
            termRows: 40,
            tmux: { socket, pane, truecolor: null },
          },
          configFlag(config),
        );
      // One daemon's life on the session: it lays the row out and names
      // itself, and its shutdown puts every option back.
      const life = async (): Promise<void> => {
        const daemon = await spawnDaemonWithEnv(env);
        try {
          await until(async () => {
            await draw();
            return own() !== before;
          }, "the daemon's layout on the session");
          expect(renderer()).toBe("main");
          await killAndWait(daemon, "SIGTERM");
          expect(own()).toBe(before);
        } finally {
          daemon.killTree();
        }
      };
      await life();
      await life();
    } finally {
      // The private server's one session: tmux exits with its last.
      spawnSync("tmux", ["-S", socket, "kill-session", "-t", "bar"]);
      removeTmpDirs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  45_000,
);
