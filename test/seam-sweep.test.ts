// [LAW:verifiable-goals] candybar-joiners-e5r4: the closing sweep. In every
// bundled frame, under every bundled theme at truecolor, 256 colours and ansi,
// the closed bar and the settings menu open on each tab, no seam joins two
// grounds drawn as one colour: Brandon's rule, "don't put the same color on two
// adjascent segments", read off the bytes a terminal is sent. Alike means one
// colour after the writer rounds it, compared for identity, as the policy
// decides it: where a theme names two neighbouring shades so near that the
// joiner lifts the arrow between them, they are still two colours, and the
// lifted arrow is that theme's look.
//
// Two kinds of seam are not the policy's to hold, and are read as drawn:
// - A seam beside a cell whose background the bundled config authors (an
//   alert). The policy colours by address and cannot see an authored
//   neighbour; reading one would make a cell's colour depend on its
//   neighbours. Those cells are listed below, by name, with the line that
//   authors each.
// - A seam whose one colour is a shade of a role whose whole ladder the depth
//   draws as one colour. That role has no second colour to give, so its cells
//   meet on one (textual-ansi names every rung of every role alike).
// - A seam whose one colour is a pressed shade whose role's ladder the depth
//   draws only in colours that stand beside the press. The same rule read for
//   the pressed state: at sixteen colours a ladder of three slots, two of them
//   on the band's items and one on the press a depth up, has nothing left.
//   Computed below from what the design stands beside a press, never listed.

import { ColorDepth, drawnColour, getThemePalette, listThemePalettes } from "@promptctl/rich-js";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import {
  DECOR_HUES,
  KEYSTONE_HUE,
  bandFor,
  hueOf,
  paletteRole,
  shadeRole,
  windowAt,
  type DecorHue,
  type Disclosure,
  type RoleShade,
} from "../src/themes/decor";
import { instantOf } from "../src/utils/instant";
import { LADDER, TODAY } from "./helpers/decor-vocabulary";
import { drawnChars, seams, shown, type Char } from "./helpers/seams";
import { sessionBar, type SessionBar } from "./helpers/session-bar";

const THEMES = listThemePalettes();
const DEPTHS = [
  ["truecolor", ColorDepth.TRUECOLOR],
  ["256", ColorDepth.EIGHT_BIT],
  ["ansi", ColorDepth.STANDARD],
] as const;
const TABS = ["session", "look", "layout", "config", "tools"] as const;
const COLS = 200;
const AT = instantOf(new Date("2026-10-30T12:00:00Z"));

// The cells of the bundled frame whose background the bundled config authors,
// by placement, with the line in src/config/default-dsl-config.ts that authors
// it. On check's payload each wears its alert's colour.
const AUTHORED: Readonly<Record<string, string>> = {
  host: `bg: "warning"`,
  context: `bg: '{{ ramp .context.contextLeft "step" 0 "error" 21 "warning" 41 (tint) }}'`,
  block: `bg: '{{ ramp (round .block.nativeUtilization) "step" 0 (tint) .settings.warnAt "warning" .settings.errorAt "error" }}'`,
};

// The frames a user sees: the closed bar, and the settings menu open on each
// tab with the theme's ⚙ open in it. Each sets every key it reads, so frames
// compose in any order.
const FRAMES: ReadonlyArray<readonly [string, (bar: SessionBar) => void]> = [
  ["closed", (bar) => bar.pick(SETTINGS_ANCHOR, "closed")],
  ...TABS.map(
    (tab) =>
      [
        `${tab} tab`,
        (bar: SessionBar) => {
          bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
          bar.pick(`${SETTINGS_NS}tab`, tab);
          bar.pick(sharedMenuStateKey("candybar.pickers"), "gear");
        },
      ] as const,
  ),
];

// Every colour, as `drawnAt` shows it, that is a shade of a role of `theme`
// whose whole ladder draws as one colour there.
function flatRoles(theme: string, drawnAt: ColorDepth): ReadonlySet<string> {
  const palette = getThemePalette(theme)!;
  const shown = (hue: (typeof DECOR_HUES)[number], shade: RoleShade) =>
    drawnColour(paletteRole(palette, shadeRole(hue, shade)), drawnAt).hex;
  return new Set(
    DECOR_HUES.flatMap((hue) =>
      new Set(LADDER.map((rung) => shown(hue, rung))).size === 1
        ? [...LADDER, "muted" as const].map((shade) => shown(hue, shade))
        : [],
    ),
  );
}

// Every pressed colour, as `drawnAt` shows it under `theme` at the bundled
// look, whose role's ladder has no rung the depth draws apart from what the
// design stands beside the press: every tone of its own band's window (its ✕
// and leads open each row), and every tone its trigger can stand beside — the
// bar's cells in each hue a bar row wears, or the band one depth up, its items
// and its leads in that band's pressed shade.
function pressesWithNoneToGive(theme: string, drawnAt: ColorDepth): ReadonlySet<string> {
  const palette = getThemePalette(theme)!;
  const { variation, shade } = TODAY;
  const shown = (hue: DecorHue, tone: RoleShade) => drawnColour(paletteRole(palette, shadeRole(hue, tone)), drawnAt).hex;
  const dealt = (hue: DecorHue) => windowAt(palette, hue, shade, drawnAt).map((tone) => shown(hue, tone));
  const keystone: readonly DecorHue[] = variation.keystones.length > 0 ? [KEYSTONE_HUE] : [];
  const pressedColour = (disclosure: Disclosure) => drawnColour(bandFor(palette, disclosure, drawnAt).state, drawnAt).hex;
  return new Set(
    [0, 1, 2, 3].flatMap((depth) => {
      const disclosure: Disclosure = { decor: TODAY, depth };
      const up: Disclosure = { decor: TODAY, depth: depth - 1 };
      const hue = hueOf(disclosure);
      const beside = depth === 0 ? [...variation.hues, ...keystone].flatMap(dealt) : [...dealt(hueOf(up)), pressedColour(up)];
      const taken = new Set([...dealt(hue), ...beside]);
      return LADDER.every((rung) => taken.has(shown(hue, rung))) ? [pressedColour(disclosure)] : [];
    }),
  );
}

// The visible text of the cell a seam leaves and the one it enters: the
// characters back to the joiner before it, and on to the joiner after it.
const cellBefore = (chars: readonly Char[], at: number): string => {
  let from = at;
  while (from > 0 && !chars[from - 1]!.joiner) from--;
  return chars.slice(from, at).map((c) => c.ch).join("");
};
const cellAfter = (chars: readonly Char[], at: number): string => {
  let to = at + 1;
  while (to < chars.length && !chars[to]!.joiner) to++;
  return chars.slice(at + 1, to).map((c) => c.ch).join("");
};

test("no seam on any bundled frame joins two grounds drawn as one colour, under every theme at truecolor, 256 colours and ansi", () => {
  const alike: string[] = [];
  const counts = { seams: 0, authored: 0, flat: 0, pressed: 0 };
  const authoredSeen = new Set<string>();
  for (const [compatibility, drawnAt] of DEPTHS) {
    const bar = sessionBar(`{ globals: { colorCompatibility: '${compatibility}' } }`, COLS);
    try {
      for (const theme of THEMES) {
        const flat = flatRoles(theme, drawnAt);
        const noneToGive = pressesWithNoneToGive(theme, drawnAt);
        bar.pick("theme", theme);
        for (const [frame, show] of FRAMES) {
          show(bar);
          const { text, segments } = bar.render(AT);
          // An authored cell as the frame draws it: its visible text.
          const authored = new Set(
            Object.keys(AUTHORED).flatMap((name) => {
              const cells = segments.get(name);
              if (cells === undefined) return [];
              authoredSeen.add(name);
              return [cells.map((cell) => cell.plain).join("").replace(/\s/g, "")];
            }),
          );
          const chars = drawnChars(text);
          for (const { left, right, at } of seams(chars)) {
            // A tail enters the terminal's own ground: no neighbour.
            if (right === undefined) continue;
            counts.seams++;
            const [before, after] = [cellBefore(chars, at), cellAfter(chars, at)];
            if (authored.has(before) || authored.has(after)) {
              counts.authored++;
              continue;
            }
            const ground = shown(left);
            if (ground !== shown(right)) continue;
            if (ground !== undefined && flat.has(ground)) {
              counts.flat++;
              continue;
            }
            if (ground !== undefined && noneToGive.has(ground)) {
              counts.pressed++;
              continue;
            }
            alike.push(`${theme} at ${compatibility}, ${frame}: "${before}" | "${after}" both on ${ground}`);
          }
        }
      }
    } finally {
      bar.dispose();
    }
  }
  expect(alike).toEqual([]);
  // Every listed cell is drawn, so the list names nothing that is not there.
  expect([...authoredSeen].sort()).toEqual(Object.keys(AUTHORED).sort());
  // Non-vacuous: every frame of every theme at every depth draws seams, and
  // the flat ladders the rule reads are textual-ansi's.
  expect(counts.seams).toBeGreaterThan(DEPTHS.length * THEMES.length * FRAMES.length * 10);
  expect(counts.flat).toBeGreaterThan(0);
});
