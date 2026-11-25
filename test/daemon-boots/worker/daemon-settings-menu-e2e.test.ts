import type { Frame } from "../../../src/render/frame";
// [LAW:verifiable-goals] candybar-settings-ui-aok.1's headline acceptance,
// measured the only way the ticket accepts: from a USER CONFIG FILE whose
// `root` is a whole tree of one row of two segments, resolved by the daemon's
// own request handling. A tree replaces the bundled rows, and the
// maintainer's own config is exactly this shape, which is why presets, edit
// mode, and the eight value controls were unreachable for the person they
// were built for.
//
// The in-process suite (test/settings-menu.test.ts) proves the synthesis. This
// one proves the thing the epic actually claims: that a user who writes a
// `root:` still has a door. Config resolution happens DAEMON-side, so the
// isolated `XDG_CONFIG_HOME` must be the daemon's — a client-side override
// would resolve nothing.

import { textOf } from "../../../src/render/frame";
import { linksOf } from "../../../src/click/read";
import { linkUrls, boldUrls } from "../../helpers/frame";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { click, render, urlWriting } from "../../helpers/daemon-e2e";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { SETTINGS_ANCHOR } from "../../../src/config/settings-menu";
import { encodeLayoutOp } from "../../../src/config/layout-ops";
import { EDIT_MODE_KEY } from "../../../src/config/loader/edit-mode";
import { DOOR_CLOSE_GLYPH, DOOR_GLYPH } from "../../../src/config/disclosure";
import { effectsOf } from "../../helpers/click";
import { sharedMenuStateKey } from "../../../src/config/menu-keys";

jest.setTimeout(30_000);

describe("candybar-settings-ui-aok.1: a daemon, a real user config", () => {
  test("a user root of one row of two segments still reaches presets and edit mode", async () => {
    const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-settings-e2e",
    );
    // The acceptance config, written where the DAEMON resolves it.
    const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, "config.json5");
    const original = JSON.stringify({ root: { h: ["directory", "model"] } });
    writeFileSync(file, original);
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-settings-e2e-project-"),
    );

    const daemon = startDaemon(env);
    try {
      const SID = "settings-e2e-1";

      // 1. The door exists, from a config that declared only two segments.
      const closed = await render(daemon, SID, projectDir);
      expect(textOf(closed)).toContain(DOOR_GLYPH);
      expect(textOf(closed)).not.toContain("✎ arrange");

      // 2. Its click opens the body — found in the rendered bytes and
      //    dispatched through the real click gate, so a menu the derived
      //    validators did not admit would fail here rather than no-op.
      await click(daemon, urlWriting(closed, SETTINGS_ANCHOR, "open"));
      const opened = textOf(await render(daemon, SID, projectDir));
      expect(opened).toContain(DOOR_CLOSE_GLYPH);
      expect(opened).not.toContain(DOOR_GLYPH);
      expect(opened).toContain("✎ arrange"); // edit mode, on the first line

      // Preset switching: 📚 saves & presets, on the first line, opens onto it.
      await click(
        daemon,
        urlWriting(
          await render(daemon, SID, projectDir),
          "candybar.tab",
          "presets",
        ),
      );
      expect(textOf(await render(daemon, SID, projectDir))).toContain(
        "▦ preset",
      );

      // 3. Edit mode is genuinely entered from the menu's first line: the
      //    row's edit chrome is on screen the moment edit mode is, and the
      //    menu stays open above it.
      const bodyOut = await render(daemon, SID, projectDir);
      expect(textOf(bodyOut)).toContain("✎ arrange");
      await click(daemon, urlWriting(bodyOut, EDIT_MODE_KEY, "arrange"));
      const editing = await render(daemon, SID, projectDir);
      expect(textOf(editing)).toContain(DOOR_CLOSE_GLYPH);
      expect(textOf(editing)).toContain("⚡ session");
      expect(
        linkUrls(editing).filter((u) => u.includes("apply-layout-op")).length,
      ).toBeGreaterThan(0);
      const removesModel = (frame: Frame) =>
        linkUrls(frame).find((url) =>
          effectsOf(url).some(
            (effect) =>
              effect.verb === "apply-layout-op" &&
              effect.args[3] ===
                encodeLayoutOp({ op: "remove", target: "model" }),
          ),
        );
      const affordance = (frame: Frame, verb: string) =>
        linkUrls(frame).find((url) =>
          effectsOf(url).some((effect) => effect.verb === verb),
        );
      const bar = () => render(daemon, SID, projectDir);
      await click(daemon, removesModel(editing)!);
      const draft = await bar();
      expect(removesModel(draft)).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe(original);
      await click(daemon, affordance(draft, "undo")!);
      const undone = await bar();
      expect(removesModel(undone)).toBeDefined();
      await click(daemon, affordance(undone, "redo")!);
      const redone = await bar();
      expect(removesModel(redone)).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe(original);
      await click(daemon, affordance(redone, "save")!);
      expect(JSON.parse(readFileSync(file, "utf8")).root).toEqual({
        h: ["directory"],
      });
      expect(textOf(await bar())).not.toContain("✓ save");
    } finally {
      await daemon.stop();
      removeTmpDirs();
      // removeTmpDirs only clears what prepareIsolatedDaemonEnv created; this
      // dir is ours, so orphaning it would leak one temp dir per run.
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// [LAW:verifiable-goals] brandon-theme-picker-bgw.etd's preset decision, on
// the only path that can decide it: a preset pick swaps the WHOLE root, which
// the daemon resolves per render. The picker may stay open across that swap
// only if the menu survives it — so two picks in a row, each through the real
// click gate, must each come back to an open picker marking the new preset.
describe("brandon-theme-picker-bgw.etd: a preset pick leaves the picker open", () => {
  test("pick compact, then default: open after each, the pick current", async () => {
    const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-preset-open");
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-preset-stays-open-project-"),
    );
    const daemon = startDaemon(env);
    try {
      const SID = "preset-stays-open-1";
      const bar = (): Promise<Frame> => render(daemon, SID, projectDir);

      await click(daemon, urlWriting(await bar(), SETTINGS_ANCHOR, "open"));
      await click(daemon, urlWriting(await bar(), "candybar.tab", "presets"));
      await click(
        daemon,
        urlWriting(
          await bar(),
          sharedMenuStateKey("candybar.pickers"),
          "candybar.apply.preset",
        ),
      );

      for (const preset of ["compact", "default"]) {
        const pick = urlWriting(await bar(), "preset", preset);
        await click(daemon, pick);
        const after = await bar();
        expect(textOf(after)).toContain("◀ ▦ preset ▶");
        // Still open: the list draws the other preset as an option, by name —
        // the ◀/▶ beside the control write a preset too, but read as arrows.
        const other = preset === "compact" ? "default" : "compact";
        const option = (name: string) =>
          linksOf(after).find(
            (l) =>
              l.text === name &&
              effectsOf(l.url).some(
                (e) => e.args[1] === "preset" && e.args[2] === name,
              ),
          );
        expect(option(other)).toBeDefined();
        // The pick is marked current in the list.
        expect(boldUrls(after)).toContain(option(preset)!.url);
      }
    } finally {
      await daemon.stop();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
