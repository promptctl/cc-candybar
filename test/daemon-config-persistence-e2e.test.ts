// [LAW:verifiable-goals] Durable mutation is a COMPOSITION property, so this drives the real `cc-candybar daemon` over a real socket: render → extract the OSC-8 URLs → decode → click → render again, across a cold restart.
// The bundled default plus one hand-authored config file, which IS the durable store: a persist click edits exactly one value span in it and every other byte survives.
// The SAME rendered theme control emits a session write with persist? unchecked and a durable one with it checked; asserting that on the wire is what proves the destination rides the click.

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { effectsOf } from "./helpers/click";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  click,
  extractUrls,
  findUrl,
  killAndWait,
  render,
  renderUntil,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("candybar-config-engine-71o.5: real-daemon click → persist → restart", () => {
  test("bundled default: clicking theme + padding forever, over the real socket, survives a cold daemon restart and a byte-identical config file", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-config-e2e",
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-config-e2e-project-"),
    );
    const userConfigPath = path.join(projectDir, ".cc-candybar.json5");
    // No hand-authored actions: the acceptance is against the BUNDLED DEFAULT,
    // with both fields authored so each durable write is one span replacement.
    const userConfigBody = `// hand-authored — a persist click edits one value span here, nothing else
{
  globals: {
    palette: "tokyo-night", // the theme every session opens in
    padding: 1,
  },
  segments: {},
}
`;
    writeFileSync(userConfigPath, userConfigBody);

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      const SID = "e2e-session-1";

      await render(sockPath, SID, projectDir);

      // Open both disclosures directly: the contract (write a disclosure's own name to its own key) is stable synthesis, not render output.
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [SID, "settings.config", "open"] },
        ]),
      );

      const menuOpen = await render(sockPath, SID, projectDir);

      const themeMenuToggleUrl = findUrl(extractUrls(menuOpen), (effects) =>
        effects.length === 1 &&
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[2] === "settings.apply.theme",
      );
      expect(themeMenuToggleUrl).toBeDefined();
      await click(sockPath, themeMenuToggleUrl!);

      // TWO themes, deliberately: one tried in-session, one committed durably —
      // one name for both would let the session pick satisfy the durability asserts.
      const [sessionTheme, targetTheme] = listResolvablePaletteNames().filter(
        (name) => name !== "tokyo-night",
      );
      if (sessionTheme === undefined || targetTheme === undefined) {
        throw new Error(
          "listResolvablePaletteNames() returned fewer than two themes besides " +
            "the bundled default's own palette — need one to try and one to commit",
        );
      }

      // ── persist? UNCHECKED: the one theme control writes the SESSION key.
      const sessionOnly = await render(sockPath, SID, projectDir);
      const sessionThemeUrl = findUrl(extractUrls(sessionOnly), (effects) =>
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[1] === "theme" &&
        effects[0]!.args[2] === sessionTheme,
      );
      expect(sessionThemeUrl).toBeDefined();
      expect(
        findUrl(extractUrls(sessionOnly), (effects) =>
          effects.some((e) => e.verb === "set-config" && e.args[1] === "palette"),
        ),
      ).toBeUndefined();

      // A CONCURRENT session over the same socket is the only thing that can show
      // "only this session"; an unchanged file proves nothing about what it renders.
      await click(sockPath, sessionThemeUrl!);
      const OTHER_SID = "e2e-session-concurrent";
      expect(await render(sockPath, SID, projectDir)).toContain(sessionTheme);
      // Open the other session's menu to the same depth FIRST: a collapsed bar
      // renders no theme name at all, so the absence would pass either way.
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [OTHER_SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [OTHER_SID, "settings.config", "open"] },
        ]),
      );
      const otherBar = await render(sockPath, OTHER_SID, projectDir);
      expect(otherBar).toContain("🎨 tokyo-night");
      expect(otherBar).not.toContain(sessionTheme);

      await click(sockPath, themeMenuToggleUrl!);

      const persistToggleUrl = findUrl(extractUrls(await render(sockPath, SID, projectDir)), (effects) =>
        effects.length === 1 &&
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[1] === "settings.persist" &&
        effects[0]!.args[2] === "true",
      );
      expect(persistToggleUrl).toBeDefined();
      await click(sockPath, persistToggleUrl!);

      const opened = await render(sockPath, SID, projectDir);
      const openedUrls = extractUrls(opened);

      // ── persist? CHECKED: the SAME control now writes the durable key.
      const themeForeverUrl = findUrl(openedUrls, (effects) =>
        effects[0]!.verb === "set-config" &&
        effects[0]!.args[1] === "palette" &&
        effects[0]!.args[2] === targetTheme,
      );
      expect(themeForeverUrl).toBeDefined();
      expect(
        findUrl(openedUrls, (effects) =>
          effects.some((e) => e.verb === "set-state" && e.args[1] === "theme"),
        ),
      ).toBeUndefined();

      expect(await render(sockPath, SID, projectDir)).toContain(sessionTheme);

      // Pin to the stepper whose `by` is positive, not whichever renders first.
      const paddingUpUrl = findUrl(openedUrls, (effects) =>
        effects.some(
          (e) =>
            e.verb === "step-config" &&
            e.args[1] === "padding" &&
            Number(e.args[2]) > 0,
        ),
      );
      expect(paddingUpUrl).toBeDefined();

      // [LAW:no-silent-failure] A durable write carries the session key to RELEASE, or the commit is invisible to the session that made it and the control goes dead.
      // Each control is pinned to ITS OWN key: an OR over both would pass on the wrong release.
      expect(
        effectsOf(themeForeverUrl!).some(
          (e) => e.verb === "set-config" && e.args[3] === "theme",
        ),
      ).toBe(true);
      expect(
        effectsOf(paddingUpUrl!).some(
          (e) => e.verb === "step-config" && e.args[3] === "padding",
        ),
      ).toBe(true);

      await click(sockPath, themeForeverUrl!);
      await click(sockPath, paddingUpUrl!);

      // Live, no restart: the durable write rides the config file's own watcher.
      // Read it on the CONCURRENT session — the clicking session's own pick outranks a durable default, so asserting there would conflate the two layers.
      const afterClicks = await renderUntil(
        sockPath,
        OTHER_SID,
        projectDir,
        (out) => out.includes(targetTheme),
        `the persisted theme "${targetTheme}" on a session that never picked one`,
      );
      expect(afterClicks).toContain(targetTheme);

      const committing = await renderUntil(
        sockPath,
        SID,
        projectDir,
        (out) => out.includes(targetTheme),
        `the committed theme "${targetTheme}" on the session that committed it`,
      );
      expect(committing).not.toContain(sessionTheme);

      // [LAW:verifiable-goals] Byte-identical OUTSIDE the two replaced spans.
      // [LAW:one-source-of-truth] The stepper starts from the file's `padding: 1`.
      const expectedBody = userConfigBody
        .replace('palette: "tokyo-night"', `palette: "${targetTheme}"`)
        .replace("padding: 1", "padding: 2");
      expect(readFileSync(userConfigPath, "utf8")).toBe(expectedBody);

      await killAndWait(daemon);
      daemon = await spawnDaemonWithEnv(env);

      // A brand-new session that never clicked: the theme NAME only appears in the config row, so open it (a UI affordance, not a config mutation) to read it.
      const FRESH_SID = "e2e-session-2-fresh";
      await render(sockPath, FRESH_SID, projectDir);
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [FRESH_SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [FRESH_SID, "settings.config", "open"] },
        ]),
      );
      const freshOut = await renderUntil(
        sockPath,
        FRESH_SID,
        projectDir,
        (out) => out.includes(targetTheme),
        `the persisted theme "${targetTheme}" for a fresh session`,
      );
      expect(freshOut).toContain(targetTheme);

      expect(readFileSync(userConfigPath, "utf8")).toBe(expectedBody);
    } finally {
      if (daemon) daemon.killTree();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
