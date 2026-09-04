// [LAW:verifiable-goals] candybar-settings-ui-0gz's acceptance, measured the
// way the defect was observed: a REAL daemon over a REAL socket whose only
// user config fails to load, broken the way it broke live — a stale
// `{{ menu }}` call missing the trigger displays candybar-settings-ui-aok.4
// made mandatory. Before this ticket that render was the red strip alone:
// nothing to click, no menu, no way back into the file from the bar.
//
// Two facts are asserted, and the second is the one that matters when the
// bar is broken: the error is loud and the bar beneath it is the bundled
// default WITH the settings menu; and the strip offers the failing file as a
// plain `file://` link — a URL the terminal opens itself, so the recovery
// path does not depend on the `cc-candybar://` handler `cc-candybar install`
// registers, which is exactly the tooling that may be misconfigured.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

jest.setTimeout(30_000);

describe("candybar-settings-ui-0gz: a config that fails to load", () => {
  test("renders the error, the bundled default with its settings menu, and a file:// link to the file", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-broken-e2e",
    );
    const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json5");
    writeFileSync(
      configPath,
      JSON.stringify({
        actions: { applyTheme: { set: "theme", from: "themes" } },
        segments: {
          t: {
            template: '{{ menu "applyTheme" }}',
            bg: "surface",
            fg: "foreground",
          },
        },
        root: { h: ["t"] },
      }),
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-broken-e2e-project-"),
    );

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      const SID = "broken-e2e-1";

      const rendered = await render(sockPath, SID, projectDir);
      const text = stripAnsi(rendered);

      // 1. The error stays loud — the strip is the truth about the file.
      expect(text).toContain(`⚠ Invalid config in ${configDir}`);
      expect(text).toContain("trigger needs a display");

      // 2. The way back into the file needs no handler of ours: a file://
      //    OSC-8 link to the path that failed, on a row naming it.
      expect(extractUrls(rendered)).toContain(pathToFileURL(configPath).href);
      expect(text).toContain(`↳ open ${configPath}`);

      // 3. Beneath the error, a working bar: the bundled default, settings
      //    menu included — and its click is honored by the real gate.
      expect(text).toContain("☰ ▸");
      await click(sockPath, urlWriting(rendered, SETTINGS_ANCHOR, "open"));
      const opened = stripAnsi(await render(sockPath, SID, projectDir));
      expect(opened).toContain("☰ ▾");
      expect(opened).toContain("▦"); // preset switching is reachable
      expect(opened).toContain("trigger needs a display"); // still loud
    } finally {
      if (daemon) await killAndWait(daemon);
      rmSync(projectDir, { recursive: true, force: true });
      removeTmpDirs();
    }
  });
});
