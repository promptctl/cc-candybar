// [LAW:verifiable-goals] candybar-config-engine-71o.5's headline acceptance:
// the epic's claim ("mutate the configuration via the menu system,
// durably") is a COMPOSITION property — click, gate, persistent write,
// watcher reload, re-render, daemon restart, fresh session — and every
// sibling ticket (.1-.4) proved its own slice against a rig of its own,
// never the composition against the daemon's own request handling. This file
// drives a daemon exactly as a real client would, across a stop and a fresh
// build: render → extract the rendered OSC-8 URLs → parseHandlerUrl
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
// file, so this test drives that through the daemon: the theme control emits
// only a session `set-state` write, the save cell appears counting the drafts
// while the file stays untouched, and one save click writes them all and
// releases the picks. Asserted on the wire and the file — not on the compiled
// action — so the draft/save split is proven where it actually happens.

import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { effectsOf } from "./helpers/click";
import { stripAnsi } from "./helpers/ansi";

// The theme picker on the door's first line, open, naming `theme` beside its swatch
// (brandon-theme-swatch-8v9r), read off the visible text.
const showsTheme = (out: string, theme: string): boolean =>
  stripAnsi(out).includes(`${theme} ▀▀▀`);
// Opening the theme picker: the write its label's click makes.
const OPEN_THEME_PICKER = ["menus.candybar_pickers", "candybar.apply.theme"];
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  click,
  linkUrls,
  findUrl,
  render,
  renderUntil,
} from "./helpers/daemon-e2e";
import { startDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("candybar-config-engine-71o.5: a daemon's click → persist → restart", () => {
  test("bundled default: clicking theme + padding forever survives a cold daemon restart and a byte-identical config file", async () => {
    const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-config-e2e",
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-config-e2e-project-"),
    );
    // The user's own file — the one durable clicks write.
    const userConfigPath = path.join(
      env.XDG_CONFIG_HOME!,
      "cc-candybar",
      "config.json5",
    );
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
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

    let daemon = startDaemon(env);
    try {
      const SID = "e2e-session-1";

      // A render warms the daemon's per-(projectDir,cwd) cache entry, which
      // is what derives and registers the click gates (deriveActionValidators
      // / deriveConfigActionValidators) — a click before the first render
      // for this project has no gate to pass yet.
      await render(daemon, SID, projectDir);

      // The settings menu is collapsed by default — open it, the click a "🍫"
      // tap dispatches.
      // The disclosure contract (write the disclosure's own name to its own
      // key) is stable synthesis, not render output, so constructing it
      // directly matches test/default-dsl-config.test.ts's own precedent
      // rather than depending on extracting it.
      await click(
        daemon,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "candybar.menu", "open"] },
        ]),
      );

      const menuOpen = await render(daemon, SID, projectDir);

      // The door's first line shows the theme picker, `🎨 theme ▀▀▀`, not its row of
      // swatches: the label is the row's toggle (a set-state write on the
      // pickers accordion key, whose member is the apply action's name, with
      // the row's page cursor beside it). Click it before any per-theme
      // swatch exists to click.
      const themeMenuToggleUrl = findUrl(linkUrls(menuOpen), (effects) =>
        effects.some(
          (e) =>
            e.verb === "set-state" &&
            e.args[1] === "menus.candybar_pickers" &&
            e.args[2] === "candybar.apply.theme",
        ),
      );
      expect(themeMenuToggleUrl).toBeDefined();
      await click(daemon, themeMenuToggleUrl!);

      // ── A control writes the SESSION key, and nothing durable: every pick
      // is a draft until it is saved.
      const sessionOnly = await render(daemon, SID, projectDir);

      // TWO themes, deliberately: one tried in-session and one committed
      // durably. Using the same name for both would let the session pick
      // satisfy the durability assertions below (a session value wins for its
      // own session), so the test would pass with the durable write missing.
      // Both are swatches the open row shows — it opens on the page holding
      // the theme in force, and a swatch writes its theme alone.
      const [sessionTheme, targetTheme] = [
        ...new Set(
          linkUrls(sessionOnly)
            .map(effectsOf)
            .filter(
              (effects) =>
                effects.length === 1 &&
                effects[0]!.verb === "set-state" &&
                effects[0]!.args[1] === "theme",
            )
            .map((effects) => effects[0]!.args[2]!),
        ),
      ].filter(
        (name) =>
          name !== "tokyo-night" && // the bundled default's globals.palette
          listResolvablePaletteNames().includes(name),
      );
      if (sessionTheme === undefined || targetTheme === undefined) {
        throw new Error(
          "the open swatch row offered fewer than two themes besides the " +
            "bundled default's own palette — need one to try and one to commit",
        );
      }
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
      await click(daemon, sessionThemeUrl!);
      const OTHER_SID = "e2e-session-concurrent";
      expect(showsTheme(await render(daemon, SID, projectDir), sessionTheme)).toBe(true);
      // Open the other session's menu to the same depth BEFORE asserting it
      // does not show the pick. A closed menu renders no theme name at all, so
      // asserting on a collapsed bar would pass whether or not the pick
      // leaked — the string simply is not reachable output. Opening it first
      // is what makes the absence evidence. It renders first, as any session
      // does before it has a link to click: a click is gated by the config
      // its session renders.
      await render(daemon, OTHER_SID, projectDir);
      await click(
        daemon,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [OTHER_SID, "candybar.menu", "open"] },
          { verb: VERB_SET_STATE, args: [OTHER_SID, ...OPEN_THEME_PICKER] },
        ]),
      );
      const otherBar = await render(daemon, OTHER_SID, projectDir);
      expect(showsTheme(otherBar, "tokyo-night")).toBe(true); // its own default, shown
      // Not named as current (a swatch beside it may well write it).
      expect(showsTheme(otherBar, sessionTheme)).toBe(false);
      expect(otherBar).not.toContain("💾"); // the draft is this session's alone

      // ── The draft is counted, and the file is untouched.
      const drafted = await render(daemon, SID, projectDir);
      expect(drafted).toContain("💾 save 1");
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);

      // Two more picks — the theme to keep, and a padding step — still drafts.
      const targetThemeUrl = findUrl(linkUrls(drafted), (effects) =>
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[1] === "theme" &&
        effects[0]!.args[2] === targetTheme,
      );
      expect(targetThemeUrl).toBeDefined();
      await click(daemon, targetThemeUrl!);
      // The padding stepper sits in the ⚙ config tab.
      await click(
        daemon,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "candybar.tab", "config"] },
        ]),
      );
      const configTab = await render(daemon, SID, projectDir);
      // The padding stepper's ▶: a relative step on the session key (the
      // step-state args are [sessionId, key, String(by)]) — the one whose `by`
      // is positive, so the file assertion below is pinned to the increment.
      const paddingUpUrl = findUrl(linkUrls(configTab), (effects) =>
        effects.some(
          (e) =>
            e.verb === "step-state" &&
            e.args[1] === "padding" &&
            Number(e.args[2]) > 0,
        ),
      );
      expect(paddingUpUrl).toBeDefined();
      await click(daemon, paddingUpUrl!);
      const twoDrafts = await render(daemon, SID, projectDir);
      expect(twoDrafts).toContain("💾 save 2");
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);

      // ── Save: one click writes both drafts to the file and releases them.
      const saveUrl = findUrl(linkUrls(twoDrafts), (effects) =>
        effects.some((e) => e.verb === "save"),
      );
      expect(saveUrl).toBeDefined();
      await click(daemon, saveUrl!);

      // Live, no daemon restart: the saved write rides the config file's own
      // watcher (RenderCache), so it is visible to a running daemon before any
      // restart. Read it on the CONCURRENT session, which never picked a theme
      // — its menu is already open from the isolation check above.
      const afterClicks = await renderUntil(
        daemon,
        OTHER_SID,
        projectDir,
        (out) => showsTheme(out, targetTheme),
        `the persisted theme "${targetTheme}" on a session that never picked one`,
      );
      expect(showsTheme(afterClicks, targetTheme)).toBe(true);

      // …and the SAVING session shows it too, with nothing left to save: the
      // save reloaded the file and released the picks.
      const committing = await renderUntil(
        daemon,
        SID,
        projectDir,
        (out) => showsTheme(out, targetTheme),
        `the committed theme "${targetTheme}" on the session that committed it`,
      );
      expect(showsTheme(committing, sessionTheme)).toBe(false);
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

      // Stop this daemon and build a FRESH one against the SAME config file,
      // the only place a saved value lives.
      await daemon.stop();
      daemon = startDaemon(env);

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
      await render(daemon, FRESH_SID, projectDir);
      await click(
        daemon,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [FRESH_SID, "candybar.menu", "open"] },
          { verb: VERB_SET_STATE, args: [FRESH_SID, ...OPEN_THEME_PICKER] },
        ]),
      );
      const freshOut = await renderUntil(
        daemon,
        FRESH_SID,
        projectDir,
        (out) => showsTheme(out, targetTheme),
        `the persisted theme "${targetTheme}" for a fresh session`,
      );
      expect(showsTheme(freshOut, targetTheme)).toBe(true);

      // The file is STILL exactly the two-span edit after the restart — a
      // restart reads it, never rewrites it.
      expect(readFileSync(userConfigPath, "utf8")).toBe(expectedBody);
    } finally {
      await daemon.stop();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
