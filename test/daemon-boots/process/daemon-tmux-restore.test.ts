// [LAW:behavior-not-structure] A new host can restore an old layout after
// an unclean upgrade. Only a private tmux server ever receives these commands.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BINDING_OPTION,
  PRIOR_OPTION,
  WROTE_OPTION,
  rowOption,
  type Prior,
} from "../../../src/daemon/retired-tmux-status";
import { textOf } from "../../../src/render/frame";
import { configFlag, render } from "../../helpers/daemon-e2e";
import { HAS_TMUX, privateTmux } from "../../helpers/private-tmux";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../../scripts/lib/until";

(HAS_TMUX ? test : test.skip)(
  "an upgraded host restores its old status layout while drawing the ordinary statusline",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-restore-"));
    const tmux = privateTmux(dir);
    const { env, sockPath, removeTmpDirs } =
      prepareIsolatedDaemonEnv("ccb-tmux-restore");
    const daemon = await spawnDaemonWithEnv(env);
    try {
      tmux.run("set-option", "-t", "bar", "status", "on");
      tmux.run("set-option", "-t", "bar", "status-format[0]", "user status");
      const original = tmux.own();
      const originalBinding = tmux
        .run("list-keys", "-T", "root", "MouseDown1Status")
        .trimEnd();
      const marker = `#[fill=terminal]#{${rowOption(0)}}`;
      const saved: Prior = {
        owner: sockPath,
        base: 1,
        status: "on",
        formats: { 0: "user status" },
        wrote: { 0: "user status", 1: marker },
      };
      tmux.run("set-option", "-t", "bar", PRIOR_OPTION, JSON.stringify(saved));
      tmux.run("set-option", "-t", "bar", WROTE_OPTION, "2");
      tmux.run("set-option", "-t", "bar", "status", "2");
      tmux.run("set-option", "-t", "bar", "status-format[1]", marker);
      tmux.run("set-option", "-t", "bar", rowOption(0), "old bar");
      tmux.run(
        "set-option",
        "-g",
        BINDING_OPTION,
        JSON.stringify({
          owner: sockPath,
          prior: { line: originalBinding },
        }),
      );
      tmux.run(
        "bind-key",
        "-T",
        "root",
        "MouseDown1Status",
        "if-shell",
        "-F",
        "#{m:ccb*,#{mouse_status_range}}",
        `run-shell -b "cc-candybar url-handle cc-candybar://tmux-status-click/${encodeURIComponent(tmux.socket)}/#{s/%//:pane_id}/#{q:mouse_status_range}"`,
      );
      expect(
        textOf(
          await render(
            sockPath,
            "tmux-restore",
            dir,
            tmux.hints,
            configFlag(tmux.config),
          ),
        ),
      ).toContain("a mark");
      await until(
        () =>
          tmux.own() === original &&
          tmux.run("show-options", "-g", "-q", "-v", BINDING_OPTION) === "",
        "the old status layout and binding records to clear",
      );
      expect(
        tmux.run("list-keys", "-T", "root", "MouseDown1Status").trimEnd(),
      ).toBe(originalBinding);
    } finally {
      await daemon.stop();
      tmux.kill();
      removeTmpDirs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
