// [LAW:verifiable-goals] brandon-menus-sjhy.b9w: every pair of neighbouring
// segments in the open settings menu is two shades joined by a filled arrow.
// rich-js joins two cells whose drawn backgrounds stand too near to tell apart
// with its thin divider instead, and the menu showed it between the preset
// control and its neighbours and between the closed tabs. Driven through the
// real loader, `resolveEffectiveGlobals` and `renderDsl`, under every bundled
// theme, with every tab and the theme's ⚙ open.
//
// brandon-menus-sjhy.4fi: a menu's items are its hue's own shades, the ones
// the dial's window names, so where a theme spells two neighbouring rungs
// under a seam — textual-ansi's flat ladder, catppuccin-latte's accent at
// `middle` — the divider is the theme's own, and the band reports it.

import { listThemePalettes } from "@promptctl/rich-js";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { instantOf } from "../src/utils/instant";
import { stripAnsi } from "./helpers/ansi";
import { POWERLINE } from "./helpers/powerline";
import { sessionBar } from "./helpers/session-bar";

const TABS = ["session", "look", "layout", "config", "tools"] as const;
const COLS = 200;

// A band whose two items the theme spells under a seam: the one divider the
// menu may draw, reported by the render as it draws it.
const ITEM_SEAM = /an open band's item \d and item \d stand/;

// The open menu's rows under every bundled theme, each tab and the theme's ⚙
// open, at `colorCompatibility` and under the session look `look`: the rows
// that carry the joiner's divider on a theme whose bands reported no item
// seam, and how many filled arrows were read.
function menuSeams(
  colorCompatibility: string,
  look: Readonly<Record<string, string>>,
  tabs: readonly (typeof TABS)[number][],
): { divided: string[]; arrows: number } {
  const bar = sessionBar(`{ globals: { colorCompatibility: '${colorCompatibility}' } }`, COLS);
  const render = () => {
    const { text, warnings } = bar.render(instantOf(new Date()));
    return { lines: text.split("\n"), warnings };
  };

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
      const { lines, warnings } = render();
      const themesOwn = warnings.some((w) => w.kind === "band-floor" && ITEM_SEAM.test(w.message));
      // The menu opens ABOVE the bar: its rows are the ones over the bar's.
      const menu = lines.slice(0, lines.length - barRows).map(stripAnsi);
      expect(menu.length).toBeGreaterThan(2);
      for (const row of menu) {
        arrows += row.split(POWERLINE.glyph).length - 1;
        if (row.includes(POWERLINE.divider) && !themesOwn) divided.push(`${theme} / ${tab}: ${row.trim()}`);
      }
    }
  }
  bar.dispose();
  return { divided, arrows };
}

test("every seam in the open settings menu is a filled arrow, under every bundled theme and tab, but where the theme spells two rungs alike — which the band reports", () => {
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
