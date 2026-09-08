// [LAW:verifiable-goals] A user who writes their own `root:` still has a door,
// proved from a real config file through a real daemon over a real socket.
// Config resolution is DAEMON-side, so the isolated XDG_CONFIG_HOME is its own.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  click,
  extractUrls,
  killAndWait,
  render,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";

jest.setTimeout(30_000);

describe("candybar-settings-ui-aok.1: real daemon, real user config", () => {
  test("a user root of one row of two segments still reaches presets and edit mode", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-settings-e2e",
    );
    const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.json5"),
      JSON.stringify({ root: { h: ["directory", "model"] } }),
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-settings-e2e-project-"),
    );

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      const SID = "settings-e2e-1";

      const closed = await render(sockPath, SID, projectDir);
      expect(stripAnsi(closed)).toContain("☰ ▸");
      expect(stripAnsi(closed)).not.toContain("✎ edit");

      // Through the real click gate: an unadmitted menu fails, never no-ops.
      await click(sockPath, urlWriting(closed, SETTINGS_ANCHOR, "open"));
      const opened = stripAnsi(await render(sockPath, SID, projectDir));
      expect(opened).toContain("☰ ▾");
      expect(opened).toContain("✎ edit");
      expect(opened).toContain("▦");

      const bodyOut = await render(sockPath, SID, projectDir);
      await click(sockPath, urlWriting(bodyOut, EDIT_MODE_KEY, "open"));
      const editing = await render(sockPath, SID, projectDir);
      expect(stripAnsi(editing)).toContain("✎ done");
      expect(
        extractUrls(editing).filter((u) => u.includes("apply-layout-op"))
          .length,
      ).toBeGreaterThan(0);
    } finally {
      if (daemon) await killAndWait(daemon);
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
