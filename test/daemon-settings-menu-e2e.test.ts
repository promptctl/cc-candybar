// [LAW:verifiable-goals] candybar-settings-ui-aok.1's headline acceptance,
// measured the only way the ticket accepts: from a USER CONFIG FILE whose
// `root` is a whole tree of one row of two segments, resolved by a REAL
// daemon over a REAL socket. A tree replaces the bundled rows, and the
// maintainer's own config is exactly this shape, which is why presets, edit
// mode, and the eight value controls were unreachable for the person they
// were built for.
//
// The in-process suite (test/settings-menu.test.ts) proves the synthesis. This
// one proves the thing the epic actually claims: that a user who writes a
// `root:` still has a door. Config resolution happens DAEMON-side, so the
// isolated `XDG_CONFIG_HOME` must be the daemon's — a client-side override
// would resolve nothing.

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
    // The acceptance config, written where the DAEMON resolves it.
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

      // 1. The door exists, from a config that declared only two segments.
      const closed = await render(sockPath, SID, projectDir);
      expect(stripAnsi(closed)).toContain("☰ ▸");
      expect(stripAnsi(closed)).not.toContain("✎ edit");

      // 2. Its click opens the body — found in the rendered bytes and
      //    dispatched through the real click gate, so a menu the derived
      //    validators did not admit would fail here rather than no-op.
      await click(sockPath, urlWriting(closed, SETTINGS_ANCHOR, "open"));
      const opened = stripAnsi(await render(sockPath, SID, projectDir));
      expect(opened).toContain("☰ ▾");
      expect(opened).toContain("✎ edit"); // edit mode
      expect(opened).toContain("▦"); // preset switching

      // 3. Edit mode is genuinely entered from here — the route that used to
      //    exist only through the `toolbar` segment this user's root drops.
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
      // removeTmpDirs only clears what prepareIsolatedDaemonEnv created; this
      // dir is ours, so orphaning it would leak one temp dir per run.
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
