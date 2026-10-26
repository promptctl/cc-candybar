// [LAW:verifiable-goals] brandon-menus-sjhy.b9w: every pair of neighbouring
// segments in the open settings menu is two shades joined by a filled arrow.
// rich-js joins two cells whose drawn backgrounds stand too near to tell apart
// with its thin divider instead, and the menu showed it between the preset
// control and its neighbours and between the closed tabs. Driven through the
// real loader, `resolveEffectiveGlobals` and `renderDsl`, under every bundled
// theme, with every tab and the theme's ⚙ open.

import { TEST_SIGNER } from "./helpers/link-signer";
import { listThemePalettes } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { perSetting } from "../src/config/setting-projections";
import { CHECK_TODAY, checkPayload } from "../src/check";
import { renderOptionsOf } from "../src/daemon/render-payload";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { instantOf } from "../src/utils/instant";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { stripAnsi } from "./helpers/ansi";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { POWERLINE } from "./helpers/powerline";

const SID = "seams0a1-2c3d-4e5f-8a7b-8c9d0e1f2a3b";
const TABS = ["session", "look", "layout", "config", "tools"] as const;
const COLS = 200;

// The open menu's rows under every bundled theme, each tab and the theme's ⚙
// open, at `colorCompatibility` and under the session look `look`: the rows
// that carry the joiner's divider, and how many filled arrows were read.
function menuSeams(
  colorCompatibility: string,
  look: Readonly<Record<string, string>>,
  tabs: readonly (typeof TABS)[number][],
): { divided: string[]; arrows: number } {
  const config = parseAndValidate(
    "<user>",
    `{ globals: { colorCompatibility: '${colorCompatibility}' } }`,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const session = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", session);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/home/tester/code/project" });
  const render = (): string[] => {
    const effective = resolveEffectiveGlobals(config, (key) => session.get(SID, key) ?? null, () => false);
    const at = instantOf(new Date());
    const payload = {
      ...checkPayload(config, effective, null, at),
      today: CHECK_TODAY,
      resettable: perSetting(() => false),
      unsaved: 0,
      history: { undo: 0, redo: 0 },
      session_id: SID,
      term: { cols: COLS },
    };
    return renderDsl(config, compiled, store, registry, payload, at, renderOptionsOf(effective, COLS), {
      onSegmentError: (name, message) => {
        throw new Error(`${name}: ${message}`);
      },
    }, effective).split("\n");
  };

  const divided: string[] = [];
  let arrows = 0;
  for (const [key, value] of Object.entries(look)) session.set(SID, key, value);
  for (const theme of listThemePalettes()) {
    session.set(SID, "theme", theme);
    session.set(SID, SETTINGS_ANCHOR, "closed");
    const barRows = render().length;
    session.set(SID, SETTINGS_ANCHOR, SETTINGS_OPEN);
    session.set(SID, sharedMenuStateKey("candybar.pickers"), "gear");
    for (const tab of tabs) {
      session.set(SID, `${SETTINGS_NS}tab`, tab);
      const lines = render();
      // The menu opens ABOVE the bar: its rows are the ones over the bar's.
      const menu = lines.slice(0, lines.length - barRows).map(stripAnsi);
      expect(menu.length).toBeGreaterThan(2);
      for (const row of menu) {
        arrows += row.split(POWERLINE.glyph).length - 1;
        if (row.includes(POWERLINE.divider)) divided.push(`${theme} / ${tab}: ${row.trim()}`);
      }
    }
  }
  registry.dispose();
  return { divided, arrows };
}

test("every seam in the open settings menu is a filled arrow, under every bundled theme and tab", () => {
  const { divided, arrows } = menuSeams("truecolor", {}, TABS);
  expect(divided).toEqual([]);
  // Non-vacuous: the menu's rows were read, seams and all.
  expect(arrows).toBeGreaterThan(listThemePalettes().length * TABS.length * 10);
});

test("at ansi, the open first tab is a filled arrow off the ✕ beside it", () => {
  // At ansi the ✕'s state is repaired onto another of the sixteen colours than
  // the one its search settled on rounds to; a nested trigger held off that
  // rounding drew in the ✕'s own colour, joined to it by the divider, on the
  // session tab of catppuccin-frappe, catppuccin-macchiato, dracula, monokai
  // and tokyo-night under this look.
  const { divided, arrows } = menuSeams("ansi", { shade: "deepest", variation: "duo" }, ["session"]);
  expect(divided).toEqual([]);
  expect(arrows).toBeGreaterThan(listThemePalettes().length * 10);
});
