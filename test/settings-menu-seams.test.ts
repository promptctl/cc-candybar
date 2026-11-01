// [LAW:verifiable-goals] brandon-menus-sjhy.b9w: every pair of neighbouring
// segments in the open settings menu is joined by a filled arrow, never by the
// thin divider U+E0B1. Driven through the
// real loader, `resolveEffectiveGlobals` and `renderDsl`, under every bundled
// theme, with every tab and the theme's ⚙ open.
//
// brandon-menus-sjhy.57p: no theme excuses a divider. Where a theme spells two
// neighbouring rungs alike (textual-ansi's flat ladder, catppuccin-latte's
// accent at `middle`), the two cells share a ground and the joiner lifts the
// arrow's ink off it, so any divider on any row fails.

import { listThemePalettes } from "@promptctl/rich-js";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/reserved-names";
import { instantOf } from "../src/utils/instant";
import { stripAnsi } from "./helpers/ansi";
import { POWERLINE } from "./helpers/powerline";
import { sessionBar } from "./helpers/session-bar";

// U+E0B1, the thin divider: no join draws it, so any on a row fails.
const DIVIDER = "\u{E0B1}";

const TABS = ["session", "look", "layout", "config", "tools"] as const;
const COLS = 200;

// The open menu's rows under every bundled theme, each tab and the theme's ⚙
// open, at `colorCompatibility` and under the session look `look`: every row,
// the menu's and the bar's, that carries the joiner's divider, and how many
// filled arrows the menu's rows hold.
function menuSeams(
  colorCompatibility: string,
  look: Readonly<Record<string, string>>,
  tabs: readonly (typeof TABS)[number][],
): { divided: string[]; arrows: number } {
  const bar = sessionBar(`{ globals: { colorCompatibility: '${colorCompatibility}' } }`, COLS);
  const render = () => ({ lines: bar.render(instantOf(new Date())).text.split("\n") });

  const divided: string[] = [];
  let arrows = 0;
  for (const [key, value] of Object.entries(look)) bar.pick(key, value);
  for (const theme of listThemePalettes()) {
    bar.pick("theme", theme);
    bar.pick(SETTINGS_ANCHOR, "closed");
    const barRows = render().lines.length;
    bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
    bar.pick(sharedMenuStateKey("candybar.pickers"), "gear");
    for (const tab of tabs) {
      bar.pick(`${SETTINGS_NS}tab`, tab);
      const { lines } = render();
      // The menu opens ABOVE the bar: its rows are the ones over the bar's.
      const rows = lines.map(stripAnsi);
      const menu = rows.slice(0, rows.length - barRows);
      expect(menu.length).toBeGreaterThan(2);
      for (const row of menu) arrows += row.split(POWERLINE.glyph).length - 1;
      for (const row of rows)
        if (row.includes(DIVIDER)) divided.push(`${theme} / ${tab}: ${row.trim()}`);
    }
  }
  bar.dispose();
  return { divided, arrows };
}

test("every seam in the open settings menu and the bar under it is a filled arrow, under every bundled theme and tab", () => {
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
