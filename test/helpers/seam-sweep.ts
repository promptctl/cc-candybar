// The closing sweep of candybar-joiners-e5r4, under one variation. In every
// bundled frame, under every bundled theme at truecolor, 256 colours and ansi,
// the closed bar and the settings menu open on each tab, no seam joins two
// grounds drawn as one colour: Brandon's rule, "don't put the same color on two
// adjascent segments", read off the bytes a terminal is sent. Alike means one
// colour after the writer rounds it, compared for identity, as the policy
// decides it: where a theme names two neighbouring shades so near that the
// joiner lifts the arrow between them, they are still two colours, and the
// lifted arrow is that theme's look.
//
// Three kinds of seam are not the policy's to hold, each read off the cells it
// joins, never off the colour they share, so a seam of two other cells that
// happen to meet on that colour is still held:
// - A seam beside a cell whose background the bundled config authors (an
//   alert). The policy colours by address and cannot see an authored
//   neighbour; reading one would make a cell's colour depend on its
//   neighbours. Those cells are listed below, by name, with the line that
//   authors each, and each must wear an alert in every frame: one wearing its
//   tint is the policy's own cell.
// - A seam between two cells of a role whose whole ladder the depth draws as
//   one colour. That role has no second rung to give (its muted form is the
//   pressed button's), so its cells meet on one (textual-ansi names every rung
//   of every role alike).
// - A seam beside a cell in a pressed shade whose role's ladder the depth
//   draws only in colours that stand beside the press. The same rule read for
//   the pressed state: at sixteen colours a ladder of three slots, two of them
//   on the band's items and one on the press a depth up, has nothing left.
//   Computed below from what the design stands beside a press, never listed.
// A cell is known by its visible text and the colour it is drawn in, and what
// it wears by the shade the render dealt it before the writer rounded it (the
// per-segment record). A seam is exempt only where every cell that could be
// the one it joins wears an exempt shade, so two cells of one text (every ✕,
// every blank lead) never lend each other an exemption.
//
// [LAW:one-source-of-truth] The one sweep: test/seam-sweep.test.ts holds it
// under every shipped variation, and audits/seam-sweep.audit.ts under every
// trial tuning, so both hold one rule with one reader.

import { ColorDepth, drawnColour, getThemePalette, listThemePalettes, type ColorRgba, type Palette, type RichText } from "@promptctl/rich-js";
import { sharedMenuStateKey } from "../../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../../src/config/settings-menu";
import { SETTINGS_NS } from "../../src/config/reserved-names";
import { resolvedStyle } from "../../src/render/rich-theme";
import {
  DECOR_HUES,
  VARIATIONS,
  bandFor,
  hueOf,
  shadeRole,
  type Decor,
  type DecorHue,
  type Disclosure,
  type RoleShade,
  type VariationName,
} from "../../src/themes/decor";
import { instantOf } from "../../src/utils/instant";
import { LADDER, TODAY, besidePress } from "./decor-vocabulary";
import { cellAfter, cellBefore, drawnChars, seams, shown, visible } from "./seams";
import { sessionBar, type SessionBar } from "./session-bar";

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

// Every shade of a role of `palette`, as the palette names it, whose whole
// ladder `drawnAt` draws as one colour.
function flatShades(palette: Palette, drawnAt: ColorDepth): ReadonlySet<string> {
  const named = (hue: DecorHue, shade: RoleShade) => palette.get(shadeRole(hue, shade));
  return new Set(
    DECOR_HUES.flatMap((hue) =>
      new Set(LADDER.map((rung) => drawnColour(named(hue, rung), drawnAt).hex)).size === 1
        ? [...LADDER, "muted" as const].map((shade) => named(hue, shade).hex)
        : [],
    ),
  );
}

// Whether the pressed shade of the band `depth` deep under `decor` has none to
// give: its role's ladder `drawnAt` draws only in colours the design stands
// beside the press (`besidePress`). The press exemption, read by every frame
// that holds a seam beside an open trigger.
export function pressHasNoneToGive(palette: Palette, decor: Decor, depth: number, drawnAt: ColorDepth): boolean {
  const hue = hueOf({ decor, depth });
  const taken = besidePress(palette, decor, depth, drawnAt);
  return LADDER.every((rung) => taken.has(drawnColour(palette.get(shadeRole(hue, rung)), drawnAt).hex));
}

// Every pressed shade under `decor`, as the palette names it, that has none to
// give at its depth. The sweep knows a cell by its text and colour, not by the
// depth of the band it presses, so it reads every depth's at once.
function pressesWithNoneToGive(palette: Palette, decor: Decor, drawnAt: ColorDepth): ReadonlySet<string> {
  return new Set(
    [0, 1, 2, 3].flatMap((depth) => {
      const disclosure: Disclosure = { decor, depth };
      return pressHasNoneToGive(palette, decor, depth, drawnAt) ? [bandFor(palette, disclosure, drawnAt).state.hex] : [];
    }),
  );
}

// A cell's background as the render dealt it, before the writer rounds it.
const dealt = (cell: RichText): ColorRgba | undefined => resolvedStyle(cell.style).bgcolor?.value;

/**
 * The bundled bar drawn at each depth, one rig per depth: parse and compile
 * of the bundled default is the cost a rig pays, and a variation is a session
 * pick like the theme and the frame, so every variation's sweep shares them.
 */
export interface SweepRigs {
  readonly bars: ReadonlyMap<string, SessionBar>;
  dispose(): void;
}

export function sweepRigs(): SweepRigs {
  const bars = new Map(DEPTHS.map(([compatibility]) => [compatibility, sessionBar(`{ globals: { colorCompatibility: '${compatibility}' } }`, COLS)] as const));
  return {
    bars,
    dispose: () => {
      for (const bar of bars.values()) bar.dispose();
    },
  };
}

/**
 * Brandon's rule held under `variation` on every bundled frame, theme and
 * depth: no seam joins two grounds drawn as one colour but the three kinds
 * above, and the authored list names exactly the cells that wear an alert.
 */
export function expectEverySeamHeld(rigs: SweepRigs, variation: VariationName): void {
  const decor: Decor = { ...TODAY, variation: VARIATIONS[variation] };
  const alike: string[] = [];
  const counts = { seams: 0, authored: 0, flat: 0, pressed: 0 };
  const authoredSeen = new Set<string>();
  const onTint: string[] = [];
  for (const [compatibility, drawnAt] of DEPTHS) {
    const bar = rigs.bars.get(compatibility)!;
    bar.pick("variation", variation);
    for (const theme of THEMES) {
      const palette = getThemePalette(theme)!;
      const flat = flatShades(palette, drawnAt);
      const noneToGive = pressesWithNoneToGive(palette, decor, drawnAt);
      const alerts = new Set((["warning", "error"] as const).map((role) => palette.get(role).hex));
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
            if (!cells.every((cell) => alerts.has(dealt(cell)?.hex ?? "")))
              onTint.push(`${theme} at ${compatibility}, ${frame}: ${name} wears ${cells.map((cell) => dealt(cell)?.hex).join()}`);
            return [visible(cells.map((cell) => cell.plain).join(""))];
          }),
        );
        // What the cells of the frame wear, by visible text and drawn colour.
        const worn = new Map<string, Set<string>>();
        const known = (text: string, ground: string | undefined): string => `${text}|${ground}`;
        for (const cell of [...segments.values()].flat()) {
          const bg = dealt(cell);
          if (bg === undefined) continue;
          const key = known(visible(cell.plain), drawnColour(bg, drawnAt).hex);
          worn.set(key, new Set([...(worn.get(key) ?? []), bg.hex]));
        }
        const wearsOnly = (text: string, ground: string | undefined, shades: ReadonlySet<string>): boolean => {
          const bgs = worn.get(known(text, ground));
          return bgs !== undefined && [...bgs].every((bg) => shades.has(bg));
        };
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
          if (wearsOnly(before, ground, flat) && wearsOnly(after, ground, flat)) {
            counts.flat++;
            continue;
          }
          if (wearsOnly(before, ground, noneToGive) || wearsOnly(after, ground, noneToGive)) {
            counts.pressed++;
            continue;
          }
          alike.push(`${theme} at ${compatibility}, ${frame}: "${before}" | "${after}" both on ${ground}`);
        }
      }
    }
  }
  expect(alike).toEqual([]);
  // Every listed cell is drawn, so the list names nothing that is not there,
  // and wears an alert wherever it is drawn, so no seam of the policy's own
  // hides behind the list.
  expect([...authoredSeen].sort()).toEqual(Object.keys(AUTHORED).sort());
  expect(onTint).toEqual([]);
  // Non-vacuous: every frame of every theme at every depth draws seams, and
  // the flat ladders the rule reads are textual-ansi's.
  expect(counts.seams).toBeGreaterThan(DEPTHS.length * THEMES.length * FRAMES.length * 10);
  expect(counts.flat).toBeGreaterThan(0);
}
