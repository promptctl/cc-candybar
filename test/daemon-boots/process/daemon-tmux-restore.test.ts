// [LAW:behavior-not-structure] What a daemon laid out on a real tmux server is
// put back when it shuts down: the at-exit handle's synchronous tmux calls
// finish before the process does.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { configFlag, killAndWait, render } from "../../helpers/daemon-e2e";
import { HAS_TMUX, privateTmux } from "../../helpers/private-tmux";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

(HAS_TMUX ? test : test.skip)(
  "shutdown restores a session's tmux status options",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-restore-"));
    const tmux = privateTmux(dir);
    const { env, sockPath, removeTmpDirs } =
      prepareIsolatedDaemonEnv("ccb-tmux-restore");
    const daemon = await spawnDaemonWithEnv(env);
    try {
      const before = tmux.own();
      await until(async () => {
        await render(
          sockPath,
          "tmux-restore",
          dir,
          tmux.hints,
          configFlag(tmux.config),
        );
        return tmux.own() !== before;
      }, "the daemon's layout on the session");

      await killAndWait(daemon, "SIGTERM");
      expect(tmux.own()).toBe(before);
    } finally {
      daemon.killTree();
      tmux.kill();
      removeTmpDirs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
