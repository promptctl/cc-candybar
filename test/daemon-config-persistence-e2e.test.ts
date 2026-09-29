// [LAW:verifiable-goals] candybar-config-engine-71o.5's headline acceptance:
// the epic's claim ("mutate the configuration via the menu system,
// durably") is a COMPOSITION property — click, gate, persistent write,
// watcher reload, re-render, daemon restart, fresh session — and every
// sibling ticket (.1-.4) proved its own slice against an in-process rig,
// never the composition against a REAL daemon over a REAL socket. This file
// drives the actual `cc-candybar daemon` subprocess exactly as a real
// client would: render → extract the rendered OSC-8 URLs → parseHandlerUrl
// (the same decode `cc-candybar url-handle` runs) → send verb+value as a
// "click" wire request → render again.
//
// Uses the BUNDLED DEFAULT (DEFAULT_DSL_CONFIG) with no hand-authored
// actions — the epic's own acceptance bullet is specifically "a user
// running the bundled default... can change (at least) default theme...
// and padding... each change survives daemon restart" — plus one minimal
// hand-authored user config file, which IS the durable store
// (candybar-config-dqe): a persist click edits exactly one value span in it
// and every other byte — comments, blank lines, key style — survives.
//
// [LAW:verifiable-goals] brandon-save-undo-bwi.hpi made every control a
// session pick — a DRAFT — and `💾 save N` the one way a draft reaches the
// file, so this test drives that over the real socket: the theme control emits
// only a session `set-state` write, the save cell appears counting the drafts
// while the file stays untouched, and one save click writes them all.
// Asserted on the wire and the file — not on the compiled
// action — so the draft/save split is proven where it actually happens.

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { effectsOf } from "./helpers/click";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  click,
  linkUrls,
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
    // No hand-authored actions — proves the epic acceptance bullet against
    // the BUNDLED DEFAULT, not a config built to exercise the mechanism. The
    // two fields the clicks below write are authored explicitly, at the
    // bundled default's own values, so each durable write is a SPAN
    // REPLACEMENT whose expected bytes this test can spell exactly.
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

      // A render warms the daemon's per-(projectDir,cwd) cache entry, which
      // is what derives and registers the click gates (deriveActionValidators
      // / deriveConfigActionValidators) — a click before the first render
      // for this project has no gate to pass yet.
      await render(sockPath, SID, projectDir);

      // The settings menu and its config row are collapsed by default — open
      // both, the same two clicks a "🍫 ▸" then "⚙ config ▸" tap dispatches.
      // The disclosure contract (write the disclosure's own name to its own
      // key) is stable synthesis, not render output, so constructing it
      // directly matches test/default-dsl-config.test.ts's own precedent
      // rather than depending on extracting it.
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [SID, "settings.config", "open"] },
        ]),
      );

      const menuOpen = await render(sockPath, SID, projectDir);

      // The config row reveals the theme control's TRIGGER (▸), not the
      // picker body — {{ menu }} is its own nested disclosure. Click ITS
      // toggle (a set-state write under the reserved menus.* namespace, whose
      // member is the apply action's name) before any per-theme option link
      // exists to click.
      const themeMenuToggleUrl = findUrl(linkUrls(menuOpen), (effects) =>
        effects.length === 1 &&
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[2] === "settings.apply.theme",
      );
      expect(themeMenuToggleUrl).toBeDefined();
      await click(sockPath, themeMenuToggleUrl!);

      // TWO themes, deliberately: one tried in-session and one committed
      // durably. Using the same name for both would let the session pick
      // satisfy the durability assertions below (a session value wins for its
      // own session), so the test would pass with the durable write missing.
      const [sessionTheme, targetTheme] = listResolvablePaletteNames().filter(
        (name) => name !== "tokyo-night", // the bundled default's globals.palette
      );
      if (sessionTheme === undefined || targetTheme === undefined) {
        throw new Error(
          "listResolvablePaletteNames() returned fewer than two themes besides " +
            "the bundled default's own palette — need one to try and one to commit",
        );
      }

      // ── A control writes the SESSION key, and nothing durable: every pick
      // is a draft until it is saved.
      const sessionOnly = await render(sockPath, SID, projectDir);
      const sessionThemeUrl = findUrl(linkUrls(sessionOnly), (effects) =>
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[1] === "theme" &&
        effects[0]!.args[2] === sessionTheme,
      );
      expect(sessionThemeUrl).toBeDefined();
      // …not a second effect on the same link, and not a second link elsewhere.
      expect(
        findUrl(linkUrls(sessionOnly), (effects) =>
          effects.some((e) => e.verb === "set-config" && e.args[1] === "palette"),
        ),
      ).toBeUndefined();
      // Nothing picked yet, so nothing to save.
      expect(sessionOnly).not.toContain("💾");

      // Take the click, then read a CONCURRENT session over the same
      // socket: the picker changed this conversation and left the other one
      // alone. That contrast is what "only this session" means, and only a
      // second live session can show it — the config file being unchanged
      // proves nothing about what another session renders.
      await click(sockPath, sessionThemeUrl!);
      const OTHER_SID = "e2e-session-concurrent";
      expect(await render(sockPath, SID, projectDir)).toContain(`🎨 ${sessionTheme}`);
      // Open the other session's menu to the same depth BEFORE asserting it
      // does not show the pick. A closed menu renders no theme name at all, so
      // asserting on a collapsed bar would pass whether or not the pick
      // leaked — the string simply is not reachable output. Opening it first
      // is what makes the absence evidence.
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [OTHER_SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [OTHER_SID, "settings.config", "open"] },
        ]),
      );
      const otherBar = await render(sockPath, OTHER_SID, projectDir);
      expect(otherBar).toContain("🎨 tokyo-night"); // its own default, shown
      expect(otherBar).not.toContain(sessionTheme);
      expect(otherBar).not.toContain("💾"); // the draft is this session's alone

      // ── The draft is counted, and the file is untouched.
      const drafted = await render(sockPath, SID, projectDir);
      expect(drafted).toContain("💾 save 1");
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);

      // Two more picks — the theme to keep, and a padding step — still drafts.
      const targetThemeUrl = findUrl(linkUrls(drafted), (effects) =>
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[1] === "theme" &&
        effects[0]!.args[2] === targetTheme,
      );
      expect(targetThemeUrl).toBeDefined();
      // The padding stepper's ▶: a relative step on the session key (the
      // step-state args are [sessionId, key, String(by)]) — the one whose `by`
      // is positive, so the file assertion below is pinned to the increment.
      const paddingUpUrl = findUrl(linkUrls(drafted), (effects) =>
        effects.some(
          (e) =>
            e.verb === "step-state" &&
            e.args[1] === "padding" &&
            Number(e.args[2]) > 0,
        ),
      );
      expect(paddingUpUrl).toBeDefined();
      await click(sockPath, targetThemeUrl!);
      await click(sockPath, paddingUpUrl!);
      const twoDrafts = await render(sockPath, SID, projectDir);
      expect(twoDrafts).toContain("💾 save 2");
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);

      // ── Save: one click writes both drafts to the file.
      const saveUrl = findUrl(linkUrls(twoDrafts), (effects) =>
        effects.some((e) => e.verb === "save"),
      );
      expect(saveUrl).toBeDefined();
      await click(sockPath, saveUrl!);

      // Live, no daemon restart: the saved write rides the config file's own
      // watcher (RenderCache), so it is visible to a running daemon before any
      // restart. Read it on the CONCURRENT session, which never picked a theme
      // — its menu is already open from the isolation check above.
      const afterClicks = await renderUntil(
        sockPath,
        OTHER_SID,
        projectDir,
        (out) => out.includes(`🎨 ${targetTheme}`),
        `the persisted theme "${targetTheme}" on a session that never picked one`,
      );
      expect(afterClicks).toContain(`🎨 ${targetTheme}`);

      // …and the SAVING session shows it too, with nothing left to save: once
      // the reload lands, the file resolves to the session's picks.
      const committing = await renderUntil(
        sockPath,
        SID,
        projectDir,
        (out) => out.includes(`🎨 ${targetTheme}`),
        `the committed theme "${targetTheme}" on the session that committed it`,
      );
      expect(committing).not.toContain(`🎨 ${sessionTheme}`);
      expect(committing).not.toContain("💾");

      // [LAW:verifiable-goals] The ticket's acceptance: the hand-authored file
      // is byte-identical OUTSIDE the two value spans the clicks replaced —
      // the leading comment, the trailing comment on the palette line, the
      // blank structure, the unquoted keys, the trailing commas all survive.
      // [LAW:one-source-of-truth] A stepper starts from what the bar SHOWS:
      // the file's own `padding: 1`, so the first ▶ writes 2.
      const expectedBody = userConfigBody
        .replace('palette: "tokyo-night"', `palette: "${targetTheme}"`)
        .replace("padding: 1", "padding: 2");
      expect(readFileSync(userConfigPath, "utf8")).toBe(expectedBody);

      // Kill this daemon and start a FRESH one against the SAME config file
      // — a real cold restart, not an in-process cache rebuild.
      await killAndWait(daemon);
      daemon = await spawnDaemonWithEnv(env);

      // A brand-new session that never clicked anything. The persisted
      // theme is now every session's baseline PALETTE (colors the fresh
      // render already carries), but the THEME NAME text only appears in the
      // settings menu's config row — collapsed by default per-session, since
      // both disclosure keys are SessionState, not something a config write
      // touches. Open them for this fresh session (a pure UI affordance, not
      // a config mutation) to assert the persisted name shows up with zero
      // prior clicks by THIS session, i.e. it came from the config default,
      // not a picked-and-remembered value.
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
        (out) => out.includes(`🎨 ${targetTheme}`),
        `the persisted theme "${targetTheme}" for a fresh session`,
      );
      expect(freshOut).toContain(`🎨 ${targetTheme}`);

      // The file is STILL exactly the two-span edit after the restart — a
      // restart reads it, never rewrites it.
      expect(readFileSync(userConfigPath, "utf8")).toBe(expectedBody);
    } finally {
      if (daemon) daemon.killTree();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
