// [LAW:verifiable-goals] candybar-settings-ui-0gz's acceptance, measured the
// way the defect was observed: a REAL daemon over a REAL socket whose only
// user config fails to load, broken the way it broke live — a stale
// `{{ menu }}` call missing the trigger displays candybar-settings-ui-aok.4
// made mandatory. Before this ticket that render was the red strip alone:
// nothing to click, no menu, no way back into the file from the bar.
//
// Three facts are asserted, and the last two are the ones that matter when
// the bar is broken: the error is loud and the bar beneath it is the bundled
// default WITH the settings menu; the strip's last row offers the failing
// file AND the complete error text as plain `file://` links — URLs the
// terminal opens itself, so the recovery path does not depend on the
// `cc-candybar://` handler `cc-candybar install` registers, which is exactly
// the tooling that may be misconfigured (this daemon has none registered);
// and the strip wraps to the client's width and caps at the client's rows
// (candybar-diagnostics-avi).

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  click,
  extractUrls,
  killAndWait,
  render,
  renderUntil,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { RichText } from "@promptctl/rich-js";

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

      // 1. The error stays loud — the strip is the truth about the file. The
      //    path is one word, so the wrap keeps it whole on a row of its own.
      expect(text).toContain("⚠ Invalid config in");
      expect(text).toContain(configPath);
      expect(text).toContain("trigger needs a display");

      // 2. The way back needs no handler of ours: the strip's last row is a
      //    file:// OSC-8 link to the path that failed. The whole message is
      //    on screen (nothing was elided), so the trailer offers no "full
      //    text" link — but the dump holds the whole message, verbatim.
      const dumpPath = path.join(
        env.XDG_STATE_HOME!,
        "cc-candybar",
        "diagnostics",
        `${SID}.txt`,
      );
      const urls = extractUrls(rendered);
      expect(urls).not.toContain(pathToFileURL(dumpPath).href);
      expect(urls).toContain(pathToFileURL(configPath).href);
      // The path is middle-truncated into the row (the URL is whole).
      expect(text).toMatch(/↳ open \/.*config\.json5\n/);
      const dumped = readFileSync(dumpPath, "utf8");
      expect(dumped).toMatch(/^ERROR\n/);
      expect(dumped).toContain(`Invalid config in ${configDir}`);
      expect(dumped).toContain("trigger needs a display");

      // 2b. The strip is shaped by the client's terminal, not a constant:
      //     every row fits the reported width, and the reported rows cap it
      //     with the elision counted on the last row — which is when the
      //     full text is worth a link, so the dump's file:// URL rides there.
      const narrow = await render(sockPath, SID, projectDir, {
        termCols: 60,
        termRows: 3,
      });
      const narrowRows = stripAnsi(narrow).split("\n");
      const stripRows = narrowRows.slice(
        0,
        narrowRows.findIndex((r) => r.startsWith("↳ ")) + 1,
      );
      expect(stripRows).toHaveLength(3);
      for (const row of stripRows) {
        expect(new RichText(row).cellLength).toBeLessThanOrEqual(58);
      }
      expect(stripRows[2]).toMatch(/^↳ \d+ more rows · open full text · /);
      expect(extractUrls(narrow)).toContain(pathToFileURL(dumpPath).href);

      // 3. Beneath the error, a working bar: the bundled default, settings
      //    menu included — and its click is honored by the real gate.
      expect(text).toContain("☰ ▸");
      await click(sockPath, urlWriting(rendered, SETTINGS_ANCHOR, "open"));
      const opened = stripAnsi(await render(sockPath, SID, projectDir));
      expect(opened).toContain("☰ ▾");
      expect(opened).toContain("▦"); // preset switching is reachable
      expect(opened).toContain("trigger needs a display"); // still loud

      // 4. Repairing the file removes the dump: the directory mirrors the
      //    last render's diagnostics, never a history of them.
      writeFileSync(configPath, JSON.stringify({ root: { h: ["directory"] } }));
      const repaired = await renderUntil(
        sockPath,
        SID,
        projectDir,
        (out) => !stripAnsi(out).includes("trigger needs a display"),
        "the repaired config",
      );
      expect(extractUrls(repaired)).not.toContain(
        pathToFileURL(dumpPath).href,
      );
      expect(existsSync(dumpPath)).toBe(false);
    } finally {
      if (daemon) await killAndWait(daemon);
      rmSync(projectDir, { recursive: true, force: true });
      removeTmpDirs();
    }
  });
});
