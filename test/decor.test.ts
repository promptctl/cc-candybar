// [LAW:verifiable-goals] candybar-render-ai7.1: the colour function. Each
// `describe` is one line of the ticket's Done-when, pinned as a property over
// generated tree SHAPES (test/helpers/seeded-trees.ts), not over hand-picked
// branches. [LAW:behavior-not-structure] Every assertion is about bytes out
// for addresses in; a different implementation of the same contract passes.
// candybar-theme-colours-6fq5.e5n: a closed cell wears its role at a shade the
// palette names, through the shade dial. candybar-joiners-e5r4.dg6: so does
// everything an open menu draws — the segment that opened it, its ✕ and leads,
// the plane its rows sit on and their items.

import { ColorDepth, Style } from "@promptctl/rich-js";
import {
  ColorRgba,
  contrastRatio,
  getThemePalette,
  listThemePalettes,
  Palette,
} from "@promptctl/rich-js";
import { floorOf } from "../src/config/globals-fields";
import type { ActiveSegment } from "../src/render/active-segment";
import { bandItemStyle, closeCell, closeOn, stateCell } from "../src/render/band-style";
import {
  VARIATIONS,
  SHADES,
  DECOR_HUES,
  KEYSTONE_HUE,
  DISTRIBUTIONS,
  TEXT_MIN_CONTRAST,
  bandFor,
  bandItemFor,
  decorEntryColour,
  decorEntryFor,
  windowAt,
  decorFor,
  decorationFor,
  bandEntries,
  hueOf,
  lineageHue,
  shadeRole,
  vocabularyOf,
  vocabularySelect,
  pressedAt,
  WHOLE_ROW,
  type Address,
  type Decor,
  type DecorEntry,
  type Lineage,
  type DecorHue,
  type Disclosure,
  type Distribution,
  type DistributionName,
  type PlacedStep,
  type RoleShade,
  type ShadeName,
  type Variation,
  type VariationName,
} from "../src/themes/decor";
import {
  allNodes,
  drawFrom,
  drawShapes,
  isUnder,
  nodeAt,
  pathKey,
  seededRng,
  withChildrenPermuted,
  withSiblingAdded,
  type Shape,
} from "./helpers/seeded-trees";
import { DRAWN, LADDER, REGISTRY, SHADE_NAMES, TODAY, VARIATION_NAMES, VDC, besidePress, cell, row, shownAt } from "./helpers/decor-vocabulary";

const DRACULA = getThemePalette("dracula");
// The depth the placement properties are stated at. Dracula names every rung
// of every role apart and truecolor draws each as named, so every window is
// its dial position's own tones (pinned below): where a cell lands is read
// straight off the dial's list.
const AT = ColorDepth.TRUECOLOR;
const placed = (decor: Decor, address: Address): DecorEntry => decorEntryFor(DRACULA, decor, address, AT);
// The decor the address properties are stated under: a two-step variation, so
// a row alternation is visible, at the default shade. Every property below is
// about placement, which no variation or shade changes; the per-variation and
// per-shade facts have their own describes.
const TWO_STEP: Decor = { variation: VARIATIONS["duo"], shade: SHADES[floorOf("shade")] };
const decorWith = (variation: Variation): Decor => ({ ...TWO_STEP, variation });
const BOUNDS = { maxDepth: 4, maxWidth: 6 };
const SHAPES = drawShapes(0xa17, 60, BOUNDS);
const ALL_NAMES = Object.keys(DISTRIBUTIONS) as DistributionName[];
const N_FREE: DistributionName[] = ["van-der-corput", "golden-angle", "uniform"];
const N_READING: DistributionName[] = ["monotonic", "ends-interleaved"];

/** path -> hex, computed by visiting each node alone. */
function colourMap(shape: Shape, distribution: Distribution): Map<string, string> {
  return new Map(
    allNodes(shape, distribution).map(({ path, address }) => [
      pathKey(path),
      decorFor(DRACULA, TWO_STEP, address, AT).hex,
    ]),
  );
}


const rung = (shade: RoleShade): number => LADDER.indexOf(shade);

// How many tones a window holds, in the test's own words: the dial position's
// count, short of the last colour the depth draws of a ladder that draws more
// than two (the pressed button in that hue needs one), and never fewer than
// two.
const windowSizeOf = (count: number, ladderColours: number): number => Math.max(2, Math.min(count, ladderColours - 1));

// A window of three or more as the dial lists every position of three, in
// the test's own words: its lowest rung, its highest, then those between,
// lowest first, so van der Corput, which deals the third entry of three at
// every other cell, walks it a rung at a time. A window of two is as built.
const walked = (window: readonly RoleShade[]): readonly RoleShade[] => {
  if (window.length < 3) return window;
  const byRung = [...window].sort((a, b) => rung(a) - rung(b));
  return [byRung[0]!, byRung.at(-1)!, ...byRung.slice(1, -1)];
};

// The rungs of the ladder nearest `from` first, in the test's own words: every
// rung not among `from`, by how many rungs it stands from the nearest of them,
// the muted form (the role blended into the background) standing one rung past
// the ladder's end on the background's side; at an equal distance, the rung
// away from the background first.
const nearestFrom = (from: readonly RoleShade[], dark: boolean): RoleShade[] => {
  const place = (shade: RoleShade): number => (shade === "muted" ? (dark ? -1 : LADDER.length) : rung(shade));
  const distance = (r: RoleShade): number => Math.min(...from.map((f) => Math.abs(rung(r) - place(f))));
  return LADDER.filter((r) => !from.includes(r)).sort(
    (a, b) => distance(a) - distance(b) || (dark ? rung(b) - rung(a) : rung(a) - rung(b)),
  );
};

describe("the shade dial", () => {
  // The dial's positions, lowest first; the jump candidates of
  // brandon-menus-sjhy.4fi follow them in the table.
  const DIAL = ["muted", "deepest", "deeper", "middle", "brighter", "brightest"] as const;

  test("runs muted, then a window of three rungs from the deepest to the brightest, each one rung above the last", () => {
    expect(SHADE_NAMES.slice(0, DIAL.length)).toEqual([...DIAL]);
    expect(SHADES.muted.tones).toEqual(["muted", "base"]);
    const windows = DIAL.slice(1).map((name) => SHADES[name].tones);
    for (const [p, tones] of windows.entries()) {
      // The window is three neighbouring rungs, from rung p.
      expect([...tones].map(rung).sort()).toEqual([p, p + 1, p + 2]);
    }
    // Turning the dial one position moves every cell exactly one rung.
    for (let p = 1; p < windows.length; p++) {
      expect(windows[p]!.map(rung)).toEqual(windows[p - 1]!.map((s) => rung(s) + 1));
    }
  });

  test("a jump candidate is the role's window widened, or two tones the whole width apart", () => {
    expect(SHADES.wide.tones.map(rung).sort()).toEqual([1, 3, 5]);
    expect(SHADES.widest.tones.map(rung).sort()).toEqual([0, 3, 6]);
    expect(SHADES.pair.tones.map(rung).sort()).toEqual([1, 5]);
    expect(SHADES["pair-wide"].tones.map(rung).sort()).toEqual([0, 6]);
  });

  test("rests on middle: one darkening, the role itself, one lightening", () => {
    expect(floorOf("shade")).toBe("middle");
    expect([...SHADES.middle.tones].sort()).toEqual(["base", "darken-1", "lighten-1"].sort());
  });

  test("error/success/warning are absent from DECOR_HUES", () => {
    // The module also pins this at compile time; this is the runtime half so a
    // future edit fails BOTH `pnpm typecheck` and `pnpm test`.
    for (const semantic of ["error", "success", "warning"]) {
      expect(DECOR_HUES).not.toContain(semantic);
    }
  });

  test("every variation steps only through decorative hues, closed and open, and the default reaches the keystone hue", () => {
    for (const { hues, open } of Object.values(VARIATIONS)) {
      expect(hues.length).toBeGreaterThan(0);
      for (const hue of [...hues, ...open]) expect(DECOR_HUES).toContain(hue);
    }
    expect(DECOR_HUES).toContain(KEYSTONE_HUE);
    // The bundled default (brandon-theme-picker-bgw.7g6) wears the accent on
    // its second row, so an open trigger can stand among accent cells.
    expect(VARIATIONS["accent"].hues).toContain(KEYSTONE_HUE);
    // A tuning (brandon-menus-sjhy.4fi) keeps the accent for its keystones:
    // no depth of a menu it opens wears it.
    const tunings = VARIATION_NAMES.filter((name) => VARIATIONS[name].keystones.length > 0);
    expect(tunings.length).toBeGreaterThan(0);
    for (const name of tunings) expect([name, VARIATIONS[name].open]).not.toContain(KEYSTONE_HUE);
  });

  test("a keystone wears the accent at the shade its place deals it, read off its authored place in its line; every other cell wears the row's hue", () => {
    const under = (name: VariationName): Decor => ({ variation: VARIATIONS[name], shade: SHADES.middle });
    const hues = (name: VariationName, r: number, count: number): DecorHue[] =>
      Array.from({ length: count }, (_, i) => placed(under(name), [row(r, 2), cell(i, count)]).hue);
    expect(hues("ends-primary", 0, 4)).toEqual(["accent", "secondary", "secondary", "accent"]);
    expect(hues("ends-primary", 1, 3)).toEqual(["accent", "secondary", "accent"]);
    expect(hues("start-primary", 1, 3)).toEqual(["accent", "secondary", "secondary"]);
    expect(hues("end-primary", 1, 3)).toEqual(["secondary", "secondary", "accent"]);
    // The bar's first cell alone: the first cell of the first row.
    expect(hues("door-primary", 0, 3)).toEqual(["accent", "secondary", "secondary"]);
    expect(hues("door-primary", 1, 3)).toEqual(["secondary", "secondary", "secondary"]);
    // A keystone's shade is its place's, like any cell's.
    for (const i of [0, 3]) {
      expect(placed(under("ends-primary"), [row(0, 2), cell(i, 4)]).shade).toBe(
        placed(under("mono"), [row(0, 2), cell(i, 4)]).shade,
      );
    }
    // A node alone on the cell axis is its line's first cell and its last.
    expect(placed(under("end-primary"), [row(1, 2)]).hue).toBe("accent");
    expect(placed(under("start-primary"), [row(1, 2)]).hue).toBe("accent");
    // A cell's place is its own however the row nests it: a group ending a row
    // at place 1 holds places 1 to 3 of 4, and only its last leaf ends the line.
    expect([1, 2, 3].map((i) => placed(under("end-primary"), [row(0, 2), cell(1, 4), cell(i, 4)]).hue)).toEqual([
      "secondary",
      "secondary",
      "accent",
    ]);
    // Edit chrome's unit shares its cell's place, so it wears the keystone too.
    expect(placed(under("ends-primary"), [row(0, 2), cell(3, 4), cell(3, 4)]).hue).toBe("accent");
  });
});

// [LAW:verifiable-goals] candybar-joiners-e5r4.686: a window holds only the
// tones the depth draws as distinct colours, by identity after rounding.
describe("a dial window at a depth", () => {
  // [LAW:verifiable-goals] candybar-joiners-e5r4.cfm: a window widens toward
  // its dial position's count, because that count is what the distributions
  // keep neighbours apart over, but never takes the last colour of a ladder
  // that draws more than two, which the pressed button in that hue needs.
  test("holds as many tones as its size — the dial's count, short of the last colour a ladder of more than two draws, never fewer than two — wherever the role has them: the dial's tones the depth draws apart, then the nearest rungs drawn apart from all the window holds, a window of three listed lowest, highest, then the one between, as the dial lists a position", () => {
    const wrong: string[] = [];
    const seen = { kept: 0, widened: 0, heldForPress: 0, fewerThanNamed: 0, flat: 0 };
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      for (const palette of REGISTRY) {
        for (const hue of DECOR_HUES) {
          const drawn = (tone: RoleShade): string => shown(palette.get(shadeRole(hue, tone))).hex;
          const size = (count: number): number => windowSizeOf(count, new Set(LADDER.map(drawn)).size);
          for (const shade of SHADE_NAMES) {
            const tones: readonly RoleShade[] = SHADES[shade].tones;
            const apart = tones.filter((tone, i) => tones.slice(0, i).every((t) => drawn(t) !== drawn(tone))).slice(0, size(tones.length));
            // Every rung nearest the dial's tones first, each taken where it
            // is drawn apart from all the window holds by then, until the
            // window holds its size.
            const expected = walked(
              nearestFrom(tones, palette.dark).reduce<RoleShade[]>(
                (held, r) => (held.length < size(tones.length) && held.every((t) => drawn(t) !== drawn(r)) ? [...held, r] : held),
                apart,
              ),
            );
            const window = windowAt(palette, hue, SHADES[shade], drawnAt);
            const where = `${palette.name} ${hue} ${shade} at ${ColorDepth[drawnAt]}`;
            if (window.join() !== expected.join()) wrong.push(`${where}: ${window.join()}, expected ${expected.join()}`);
            // Its size, else as many colours as the role's shades draw — its
            // ladder and the dial's own tones — and the tones it holds draw
            // as that many colours.
            const has = new Set([...LADDER, ...tones].map(drawn)).size;
            if (window.length !== Math.min(size(tones.length), has)) wrong.push(`${where}: ${window.length} tones, its size is ${size(tones.length)} and the role draws ${has}`);
            if (new Set(window.map(drawn)).size !== window.length) wrong.push(`${where}: ${window.join()} draws as fewer colours than it holds`);
            // What the size leaves for: wherever the ladder draws more than
            // two colours, one of them is drawn as none of the window's tones,
            // so the button pressed in that hue has a colour of its own.
            const ladderColours = new Set(LADDER.map(drawn));
            if (ladderColours.size > 2 && [...ladderColours].every((colour) => window.some((t) => drawn(t) === colour))) wrong.push(`${where}: ${window.join()} takes every colour its ladder draws`);
            seen[
              has === 1
                ? "flat"
                : ladderColours.size < tones.length
                  ? "fewerThanNamed"
                  : size(tones.length) < tones.length
                    ? "heldForPress"
                    : window.some((t) => !tones.includes(t))
                      ? "widened"
                      : "kept"
            ]++;
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    // Every case is met: windows kept whole, widened along the ladder, held
    // short of the dial's count to leave the press a colour (a ladder drawing
    // as many colours as the position names), held to the colours a ladder
    // draws where it draws fewer than the position names, and the flat
    // ladders (textual-ansi's) — and at truecolor, outside a flat ladder,
    // every window is the dial's own.
    expect([seen.kept > 0, seen.widened > 0, seen.heldForPress > 0, seen.fewerThanNamed > 0, seen.flat > 0]).toEqual([true, true, true, true, true]);
    for (const palette of REGISTRY.filter((p) => p.name !== "textual-ansi")) {
      for (const hue of DECOR_HUES) {
        for (const shade of SHADE_NAMES) {
          expect([palette.name, hue, shade, windowAt(palette, hue, SHADES[shade], AT)]).toEqual([palette.name, hue, shade, SHADES[shade].tones]);
        }
      }
    }
  });

  test("what a theme's preview samples is each hue's window at the depth, in the window's order over as many places as the dial names tones, its hue groups side by side and meeting as a row that turns hue does", () => {
    const wrong: string[] = [];
    const seen = { moved: 0, noneToGive: 0 };
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      for (const palette of REGISTRY) {
        const drawn = (entry: DecorEntry): string => shown(decorEntryColour(palette, entry)).hex;
        for (const shade of SHADE_NAMES) {
          for (const name of ["accent", "duo", "alt"] as const) {
            const decor: Decor = { variation: VARIATIONS[name], shade: SHADES[shade] };
            const sampled = vocabularyOf(palette, decor, drawnAt);
            const dealt = decor.variation.hues.flatMap((hue) => {
              const window = windowAt(palette, hue, SHADES[shade], drawnAt);
              return SHADES[shade].tones.map((_, at) => ({ hue, shade: window[at % window.length]! }));
            });
            const where = `${palette.name} ${name}/${shade} at ${ColorDepth[drawnAt]}: ${sampled.map((e) => `${e.hue} ${e.shade}`).join(", ")}`;
            // The groups meet between the last place of the first hue and the first of the second.
            const turn = SHADES[shade].tones.length;
            if (sampled.length !== dealt.length) wrong.push(`${where}, not one place per tone the dial names, per hue`);
            sampled.forEach((entry, i) => {
              if (entry.hue !== dealt[i]!.hue) wrong.push(`${where}, place ${i} not in ${dealt[i]!.hue}`);
              if (entry.shade === dealt[i]!.shade) return;
              seen.moved++;
              // A place moves only at the meeting, and only where the place
              // across it was drawn like it, as dealt or as it stands.
              const across = i === turn ? turn - 1 : i === turn - 1 ? turn : undefined;
              if (across === undefined || ![drawn(dealt[across]!), drawn(sampled[across]!)].includes(drawn(dealt[i]!)))
                wrong.push(`${where}, place ${i} moved, though no place across a meeting was drawn like it`);
            });
            const beside = (i: number): string[] => [sampled[i - 1], sampled[i + 1]].flatMap((e) => (e === undefined ? [] : [drawn(e)]));
            const hasRungToGive = (i: number): boolean => LADDER.some((rung) => !beside(i).includes(drawn({ hue: sampled[i]!.hue, shade: rung })));
            for (let i = 0; i + 1 < sampled.length; i++) {
              const [left, right] = [sampled[i]!, sampled[i + 1]!];
              if (drawn(left) !== drawn(right)) continue;
              if (left.hue === right.hue && windowAt(palette, left.hue, SHADES[shade], drawnAt).length === 1) continue;
              if (left.hue !== right.hue && !hasRungToGive(i) && !hasRungToGive(i + 1)) {
                seen.noneToGive++;
                continue;
              }
              wrong.push(`${where}, places ${i} and ${i + 1} drawn alike`);
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    // Non-vacuous: at some depth two hues' groups meet on one colour, and the
    // turn is held by a move; and where neither has a rung, they meet.
    expect([seen.moved > 0, seen.noneToGive > 0]).toEqual([true, true]);
  });
});

describe("the colour is its role at a shade, as the palette names it", () => {
  test("byte for byte the palette's own entry, for every theme, shade and role", () => {
    for (const name of listThemePalettes()) {
      const palette = getThemePalette(name);
      for (const shade of SHADE_NAMES) {
        const entries = VARIATIONS.duo.hues.flatMap((hue) => SHADES[shade].tones.map((tone) => ({ hue, shade: tone })));
        for (const entry of entries) {
          const named = entry.shade === "base" ? entry.hue : `${entry.hue}-${entry.shade}`;
          expect([name, named, decorEntryColour(palette, entry).hex]).toEqual([
            name,
            named,
            palette.get(named)!.hex,
          ]);
        }
      }
    }
  });

  test("the row chooses the hue and the place in the row chooses the shade", () => {
    // Row 1 of 2 (vdc 0.5 × 2 = 1 -> secondary), cell 3 of 6 (vdc 0.75, in
    // the upper half -> entry 2 of the middle window, the role itself).
    expect(placed(TWO_STEP, [row(1, 2), cell(3, 6)])).toEqual({ hue: "secondary", shade: "base" });
    // Only the innermost row counts: a row stacked above the whole bar (edit
    // mode's reset banner wraps the content as row 1 of 2) recolours nothing.
    expect(placed(TWO_STEP, [row(1, 2), row(0, 2), cell(3, 6)])).toEqual({ hue: "primary", shade: "base" });
    // A cell is a leaf of its row, at its own place on the row's line however
    // the row nests it: the third leaf of a group at place 2 is at place 4,
    // and wears what a cell the row holds directly at 4 wears.
    expect(placed(TWO_STEP, [row(1, 2), cell(2, 6), cell(4, 6)])).toEqual(
      placed(TWO_STEP, [row(1, 2), cell(4, 6)]),
    );
    // Edit mode's unit around a content cell shares that cell's place, every
    // child of it, so entering edit mode recolours nothing.
    expect(placed(TWO_STEP, [row(1, 2), cell(3, 6), cell(3, 6)])).toEqual(
      placed(TWO_STEP, [row(1, 2), cell(3, 6)]),
    );
    // A bar with no vertical container is one row, in the first bar hue.
    expect(placed(TWO_STEP, [cell(1, 4)])).toEqual({ hue: TWO_STEP.variation.hues[0], shade: "base" });
  });

  test("the shade step is placed by its OWN distribution", () => {
    // Cell 1 of 4: vdc 0.5, read by halves, in [½, 1) -> entry 2; monotonic
    // 0.375, read by equal bins, in [⅓, ⅔) -> entry 1.
    expect(placed(TWO_STEP, [cell(1, 4)]).shade).toBe(SHADES.middle.tones[2]);
    expect(
      placed(TWO_STEP, [{ ...cell(1, 4), distribution: DISTRIBUTIONS.monotonic }]).shade,
    ).toBe(SHADES.middle.tones[1]);
  });

  test("a row walks up and down its window a rung at a time, every window in its own steps", () => {
    // Van der Corput read by halves lands a row's cells on entries 0, 2, 1, 2
    // of three, over and over; the window is listed low, high, middle, so the
    // row reads low, middle, high, middle, low, … however long it runs.
    const walk = (shade: ShadeName): RoleShade[] =>
      Array.from(
        { length: 16 },
        (_, i) => placed({ ...TWO_STEP, shade: SHADES[shade] }, [row(0, 2), cell(i, 16)]).shade,
      );
    for (const shade of ["deepest", "deeper", "middle", "brighter", "brightest"] as const) {
      const low = rung(SHADES[shade].tones[0]);
      expect([shade, walk(shade).map((s) => rung(s) - low)]).toEqual([
        shade,
        Array.from({ length: 16 }, (_, i) => [0, 1, 2, 1][i % 4]),
      ]);
    }
    // A widened window walks the same way by its wider steps, and a position
    // of two tones alternates them.
    for (const shade of SHADE_NAMES) {
      const { tones } = SHADES[shade];
      const [low, middle, high] = [...tones].sort((a, b) => rung(a) - rung(b));
      const steps = tones.length === 3 ? [low, middle, high, middle] : tones;
      expect([shade, walk(shade)]).toEqual([shade, Array.from({ length: 16 }, (_, i) => steps[i % steps.length])]);
    }
  });

  // [LAW:verifiable-goals] candybar-joiners-e5r4.tx7: the property, stated
  // once, for the distributions that carry it and the least window each
  // carries it over (`DISTRIBUTIONS` says why these): van der Corput, the
  // default, over two tones or more, and golden angle over three or more. The
  // mechanism reads the position alone, so a row's length is only how far the
  // property is checked, never an input to the tone. candybar-joiners-e5r4.686:
  // over the windows each depth produces, in every bundled theme and hue, and
  // judged on the colours the depth draws, not the names of the tones.
  // candybar-joiners-e5r4.cfm: over every window a dial position that names
  // that many produces at every depth. A window holds its size — the
  // position's count, short of the last colour a ladder of more than two
  // draws, never fewer than two — so at ansi a three-slot ladder's window
  // holds two, and a distribution whose least window that is not is not
  // claimed over it: the edge is stated instead.
  const KEEP_NEIGHBOURS_APART: ReadonlyArray<readonly [DistributionName, number]> = [
    ["van-der-corput", 2],
    ["golden-angle", 3],
  ];

  test("no two cells side by side are drawn in one colour, in any row up to sixteen long, under every theme, hue, dial position and depth: by van der Corput over every window of two tones or more, and by golden angle over every window of three; a window holds its size wherever the role has it, and a window short of its position's count is that edge", () => {
    const alike: string[] = [];
    const short: string[] = [];
    let rows = 0;
    const held = { goldenAngle: 0, widenedUnderGoldenAngle: 0, edge: 0 };
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      for (const palette of REGISTRY) {
        for (const hue of DECOR_HUES) {
          const drawnTone = (tone: RoleShade): string => shown(palette.get(shadeRole(hue, tone))).hex;
          const variation: Variation = { hues: [hue], run: WHOLE_ROW, keystones: [], open: [hue] };
          for (const shade of SHADE_NAMES) {
            const decor: Decor = { variation, shade: SHADES[shade] };
            const tones: readonly RoleShade[] = SHADES[shade].tones;
            const window = windowAt(palette, hue, SHADES[shade], drawnAt);
            const where = `${palette.name} ${hue} ${shade} at ${ColorDepth[drawnAt]}`;
            // The rule's edge, in the test's words: a window holds its size
            // wherever the role's shades draw that many colours, and every
            // colour they draw where they draw fewer.
            const size = windowSizeOf(tones.length, new Set(LADDER.map(drawnTone)).size);
            const has = new Set([...LADDER, ...tones].map(drawnTone)).size;
            if (window.length !== Math.min(size, has)) short.push(`${where}: ${window.length} tones, its size is ${size} and the role draws ${has}`);
            if (window.length < tones.length) held.edge++;
            for (const [name, least] of KEEP_NEIGHBOURS_APART) {
              // A position naming fewer tones than the distribution's least
              // window is outside its guarantee (over two, no rule keeps
              // golden angle's neighbours apart); a window short of it is the
              // edge, held above.
              if (tones.length < least || window.length < least) continue;
              if (name === "golden-angle") {
                held.goldenAngle++;
                if (window.some((tone) => !tones.includes(tone))) held.widenedUnderGoldenAngle++;
              }
              const colour = (index: number, count: number): string => {
                const entry = decorEntryFor(palette, decor, [row(0, 2), { ...cell(index, count), distribution: DISTRIBUTIONS[name] }], drawnAt);
                return shown(decorEntryColour(palette, entry)).hex;
              };
              for (let count = 2; count <= 16; count++) {
                rows++;
                for (let i = 0; i + 1 < count; i++) {
                  if (colour(i, count) === colour(i + 1, count))
                    alike.push(`${palette.name} ${hue} ${shade} at ${ColorDepth[drawnAt]}, ${name}, ${count} cells: ${i} and ${i + 1}`);
                }
              }
            }
          }
        }
      }
    }
    expect(alike).toEqual([]);
    expect(short).toEqual([]);
    expect(rows).toBeGreaterThan(DRAWN.length * REGISTRY.length * DECOR_HUES.length * SHADE_NAMES.length * 10);
    // Non-vacuous: golden angle is held over windows a depth widened back to
    // three, and the edge — a window short of its position's count (a
    // three-slot ladder at ansi, textual-ansi's flat ladders) — is met and
    // stated.
    expect([held.goldenAngle > 0, held.widenedUnderGoldenAngle > 0, held.edge > 0]).toEqual([true, true, true]);
  });

  test("the even spreads deal every tone of a window an equal run, monotonic in the order the window lists them", () => {
    for (const shade of SHADE_NAMES) {
      const { tones } = SHADES[shade];
      for (const runs of [1, 2, 3, 4]) {
        const count = tones.length * runs;
        const dealt = (name: DistributionName): RoleShade[] =>
          Array.from(
            { length: count },
            (_, i) =>
              placed({ ...TWO_STEP, shade: SHADES[shade] }, [
                row(0, 2),
                { ...cell(i, count), distribution: DISTRIBUTIONS[name] },
              ]).shade,
          );
        expect([shade, count, dealt("monotonic")]).toEqual([shade, count, tones.flatMap((tone) => Array<RoleShade>(runs).fill(tone))]);
        const interleaved = dealt("ends-interleaved");
        expect([shade, count, tones.map((tone) => interleaved.filter((t) => t === tone).length)]).toEqual([
          shade,
          count,
          tones.map(() => runs),
        ]);
      }
    }
  });

  test("a muted row alternates its role's muted form with the role itself, in one hue", () => {
    const muted: Decor = { ...TWO_STEP, shade: SHADES.muted };
    for (const r of [0, 1]) {
      const entries = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => placed(muted, [row(r, 2), cell(i, 8)]));
      expect(new Set(entries.map((e) => e.hue)).size).toBe(1);
      expect(entries.map((e) => e.shade)).toEqual(["muted", "base", "muted", "base", "muted", "base", "muted", "base"]);
    }
  });

  test("no two rows side by side share a hue", () => {
    // Rows land at 0, ½, ¼, ¾, … and a row's hue is the half it falls in, so
    // the first bit alternates them however many rows the bar stacks.
    const hues = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => placed(TWO_STEP, [row(i, 8)]).hue);
    expect(hues).toEqual(Array.from({ length: 8 }, (_, i) => TWO_STEP.variation.hues[i % 2]));
  });

  test("row n wears step n of every variation, and a one-step variation is uniform", () => {
    for (const name of VARIATION_NAMES) {
      const decor = decorWith(VARIATIONS[name]);
      const steps: readonly string[] = decor.variation.hues;
      // The middle cell of three: no keystone place, so the row's stepped hue.
      const hues = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => placed(decor, [row(i, 8), cell(1, 3)]).hue);
      expect([name, hues]).toEqual([name, Array.from({ length: 8 }, (_, i) => steps[i % steps.length])]);
    }
    // The shade is the variation's business nowhere: the cell alone picks it.
    for (const name of VARIATION_NAMES) {
      expect(placed(decorWith(VARIATIONS[name]), [row(1, 2), cell(3, 6)]).shade).toBe("base");
    }
  });

  test("a whole-row variation keeps one hue across a row; alt steps it every three cells", () => {
    const along = (variation: Variation, r: number) =>
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => placed(decorWith(variation), [row(r, 2), cell(i, 8)]).hue);
    for (const name of ["accent", "duo", "mono"] as const) {
      const { hues } = VARIATIONS[name];
      expect([name, along(VARIATIONS[name], 0)]).toEqual([name, Array(8).fill(hues[0])]);
    }
    // Variant C of 8fp: the shade turns at every cell, the hue after one cell
    // per shade — and each row starts on its own step, so rows still differ.
    const S = "secondary";
    const A = "accent";
    expect(along(VARIATIONS.alt, 0)).toEqual([S, S, S, A, A, A, S, S]);
    expect(along(VARIATIONS.alt, 1)).toEqual([A, A, A, S, S, S, A, A]);
    // Never a hue change at every cell: within a run, neighbours share a hue
    // and differ by shade.
    const shades = [0, 1, 2].map((i) => placed(decorWith(VARIATIONS.alt), [row(0, 2), cell(i, 8)]).shade);
    expect(new Set(shades).size).toBe(3);
  });

  test("alt's run counts leaves: a group's cells turn the hue as the row's own cells do", () => {
    const alt = decorWith(VARIATIONS.alt);
    // A group at place 1 holding places 1 to 3: its last leaf is the row's
    // fourth cell, past the first run of three.
    const grouped = [1, 2, 3].map((i) => placed(alt, [row(0, 2), cell(1, 8), cell(i, 8)]).hue);
    const flat = [1, 2, 3].map((i) => placed(alt, [row(0, 2), cell(i, 8)]).hue);
    expect(grouped).toEqual(flat);
    expect(grouped).toEqual(["secondary", "secondary", "accent"]);
  });

  test("a stack of rows inside a row restarts the alternation: siblings alternate, not lines", () => {
    // root { v: [ { v: [x, y] }, z ] }: y is the second of its stack, z the
    // second of the bar's, so the two lines touch in one hue. Stated, not
    // hidden — see decorEntryFor.
    expect(placed(TWO_STEP, [row(0, 2), row(1, 2)]).hue).toBe(placed(TWO_STEP, [row(1, 2)]).hue);
  });

  test("the root selects the variation's first step at the shade's first entry — or the keystone hue, being the bar's first cell and its last", () => {
    // The empty address has no step to place, so no distribution can reach it.
    for (const name of VARIATION_NAMES) {
      for (const shade of SHADE_NAMES) {
        const decor: Decor = { variation: VARIATIONS[name], shade: SHADES[shade] };
        const hue = VARIATIONS[name].keystones.length === 0 ? VARIATIONS[name].hues[0] : KEYSTONE_HUE;
        expect(placed(decor, [])).toEqual({ hue, shade: SHADES[shade].tones[0] });
      }
    }
  });

  test("an open bar trigger opens its decor's lineage at depth 0, whatever its row", () => {
    for (const name of VARIATION_NAMES) {
      for (const shade of SHADE_NAMES) {
        const decor: Decor = { variation: VARIATIONS[name], shade: SHADES[shade] };
        for (const address of [[row(0, 2), cell(2, 4)], [row(1, 2), cell(0, 4)]]) {
          const region = { kind: "bar", decor, address } as const;
          const { disclosure } = decorationFor(DRACULA, region, ColorDepth.TRUECOLOR);
          expect([name, shade, disclosure]).toEqual([name, shade, { decor, depth: 0 }]);
          expect(hueOf(disclosure)).toBe(VARIATIONS[name].open[0]);
        }
      }
    }
  });

});

// [LAW:verifiable-goals] candybar-joiners-e5r4.5x1: a window keeps one hue's
// tones apart and the distribution keeps neighbours of one hue on different
// tones, but where a row turns from one hue to the next (`alt` every three
// cells, either side of a keystone) the cells either side each take a tone of
// their own hue's window, and at 256 colours and ansi two hues' rungs often
// round onto one colour. The rule, stated over every variation, dial
// position, bundled theme and depth, for every row up to sixteen long, on the
// colours the depth draws: two cells side by side are two colours wherever
// either of them has a rung of its own ladder drawn as neither of the cells
// beside it. candybar-joiners-e5r4.34r: and a cell the rule moves is drawn
// apart from what an open trigger on the bar wears, wherever its ladder has a
// rung drawn as neither of its neighbours nor that, because a trigger can
// stand beside it and the press keeps apart only from what the windows deal;
// both cells of a turn are tried apart from the press before either falls
// back to its neighbours alone.
describe("where a row turns hue", () => {
  // The hue a place is dealt, in the test's own words: the row starts on its
  // own step (row 0 of 2 on the first, row 1 on the second) and steps every
  // run of cells, and a keystone place wears the keystone hue.
  const hueAt = (variation: Variation, r: number, i: number, count: number): DecorHue => {
    const keystone = variation.keystones.some((at) => (at === "bar-start" ? r === 0 && i === 0 : at === "line-start" ? i === 0 : i === count - 1));
    return keystone ? KEYSTONE_HUE : variation.hues[(r + Math.floor(i / variation.run)) % variation.hues.length]!;
  };
  const ROWS = Array.from({ length: 15 }, (_, i) => i + 2);

  test.each(VARIATION_NAMES)(
    "under %s, two cells side by side are drawn alike only where neither has a rung of its own ladder drawn as neither of its neighbours; a cell keeps its hue, leaves the tone its place deals only where a cell across a turn was drawn like it, is drawn apart from an open trigger's pressed shade wherever its ladder has a rung apart from both neighbours and the press, falls back onto it only where the cell across the turn has no such rung either, and leaves its window only where no tone of it stands apart from all it keeps off",
    (name) => {
      const variation = VARIATIONS[name];
      const wrong: string[] = [];
      const seen = { turns: 0, dealtAlike: 0, moved: 0, widened: 0, noneToGive: 0, offPress: 0 };
      for (const drawnAt of DRAWN) {
        const shown = shownAt(drawnAt);
        for (const palette of REGISTRY) {
          // How each entry is drawn, rounded once per palette and depth, since
          // the walk below reads it for every pair of every line.
          const drawnOf = new Map<string, string>();
          const drawn = (entry: DecorEntry): string => {
            const key = `${entry.hue} ${entry.shade}`;
            const known = drawnOf.get(key);
            if (known !== undefined) return known;
            const hex = shown(decorEntryColour(palette, entry)).hex;
            drawnOf.set(key, hex);
            return hex;
          };
          const ladder = (hue: DecorHue): string[] => LADDER.map((rung) => drawn({ hue, shade: rung }));
          for (const shade of SHADE_NAMES) {
            const decor: Decor = { variation, shade: SHADES[shade] };
            const windowOf = (hue: DecorHue) => windowAt(palette, hue, SHADES[shade], drawnAt);
            // What every open trigger on the bar wears: each opens the
            // lineage at depth 0, wherever it stands.
            const pressed = shown(bandFor(palette, { decor, depth: 0 }, drawnAt).state).hex;
            for (const r of [0, 1]) {
              for (const count of ROWS) {
                const where = `${palette.name} ${shade} at ${ColorDepth[drawnAt]}, row ${r}, ${count} cells`;
                const line = Array.from({ length: count }, (_, i) => decorEntryFor(palette, decor, [row(r, 2), cell(i, count)], drawnAt));
                // What each place deals before any turn is held: its hue's window, read by its place.
                const dealt = line.map((_, i) => {
                  const hue = hueAt(variation, r, i, count);
                  return { hue, shade: vocabularySelect(windowOf(hue), cell(i, count)) };
                });
                const besideOf = (i: number): string[] => [line[i - 1], line[i + 1]].flatMap((entry) => (entry === undefined ? [] : [drawn(entry)]));
                const hasRungToGive = (i: number): boolean => ladder(line[i]!.hue).some((c) => !besideOf(i).includes(c));
                // What stood beside a cell when its turn was read. The rule
                // reads the line from its first place to its last, so each
                // neighbour then wore what it was dealt or what it wears now,
                // and the cell is judged against both.
                const whenRead = (i: number): string[] => [i - 1, i + 1].flatMap((j) => (line[j] === undefined ? [] : [drawn(dealt[j]!), drawn(line[j]!)]));
                const rungApart = (i: number, off: readonly string[]): boolean => ladder(line[i]!.hue).some((c) => !off.includes(c));
                // What a moved cell keeps off: its neighbours, and the press
                // as well wherever its ladder has a rung apart from all of them.
                const keptOff = (i: number): string[] => (rungApart(i, [...whenRead(i), pressed]) ? [...whenRead(i), pressed] : whenRead(i));
                line.forEach((entry, i) => {
                  if (entry.hue !== dealt[i]!.hue) wrong.push(`${where}: ${i} wears ${entry.hue}, dealt ${dealt[i]!.hue}`);
                  if (entry.shade === dealt[i]!.shade) return;
                  seen.moved++;
                  // A cell moves only where a cell across a turn beside it was
                  // drawn like what it was dealt, as dealt or as it stands.
                  const metAcross = [i - 1, i + 1].some(
                    (j) => dealt[j] !== undefined && dealt[j]!.hue !== entry.hue && [drawn(dealt[j]!), drawn(line[j]!)].includes(drawn(dealt[i]!)),
                  );
                  if (!metAcross) wrong.push(`${where}: ${i} left its tone, though no cell across a turn was drawn like it`);
                  if (keptOff(i).includes(pressed)) {
                    seen.offPress++;
                    if (drawn(entry) === pressed) wrong.push(`${where}: ${i} wears ${entry.shade}, drawn as the press ${pressed}`);
                  }
                  // The order the rule moves in: both cells of a turn are
                  // tried apart from the press before either is tried apart
                  // from its neighbours alone. So a moved cell falls back onto
                  // the press only where the cell across the turn had no rung
                  // apart from its own neighbours and the press either. When
                  // that turn was read the two were drawn alike, so the cell
                  // across is judged against its own colour too.
                  if (drawn(entry) === pressed) {
                    const across = [i - 1, i + 1].filter((j) => line[j] !== undefined && line[j]!.hue !== entry.hue);
                    if (across.every((j) => rungApart(j, [...whenRead(j), drawn(dealt[j]!), drawn(line[j]!), pressed])))
                      wrong.push(`${where}: ${i} fell back onto the press ${pressed}, though the cell across its turn had a rung apart from it`);
                  }
                  if (windowOf(entry.hue).includes(entry.shade)) return;
                  seen.widened++;
                  const apart = windowOf(entry.hue).filter((tone) => !keptOff(i).includes(drawn({ hue: entry.hue, shade: tone })));
                  if (apart.length > 0) wrong.push(`${where}: ${i} wears ${entry.shade}, past its window's ${apart.join()}`);
                });
                for (let i = 0; i + 1 < count; i++) {
                  const [left, right] = [line[i]!, line[i + 1]!];
                  if (left.hue !== right.hue) {
                    seen.turns++;
                    if (drawn(dealt[i]!) === drawn(dealt[i + 1]!)) seen.dealtAlike++;
                  }
                  if (drawn(left) !== drawn(right)) continue;
                  // One hue: only a window of one tone, a role whose whole
                  // ladder draws as one colour (held by the window's own test).
                  if (left.hue === right.hue && windowOf(left.hue).length === 1) continue;
                  if (left.hue !== right.hue && !hasRungToGive(i) && !hasRungToGive(i + 1)) {
                    seen.noneToGive++;
                    continue;
                  }
                  wrong.push(`${where}: ${i} and ${i + 1} both ${drawn(left)} (${left.hue} ${left.shade} | ${right.hue} ${right.shade})`);
                }
              }
            }
          }
        }
      }
      expect(wrong).toEqual([]);
      // A whole-row variation with no keystone never turns along a row; one
      // that turns meets two hues on one colour at some depth, and holds each
      // such turn by moving a cell.
      const turns = variation.run !== WHOLE_ROW || variation.keystones.length > 0;
      expect([name, seen.turns > 0, seen.dealtAlike > 0, seen.moved > 0, seen.offPress > 0]).toEqual([name, turns, turns, turns, turns]);
    },
  );

  test("at a turn drawn as one colour the cell after it moves: to a tone of its window drawn apart from both its neighbours, else past its window along its ladder, and where neither cell has a rung to give, the seam is the joiner's", () => {
    const ansi = ColorDepth.STANDARD;
    const shown = shownAt(ansi);
    // The bundled bar's second row under alt, at ansi: accent for three
    // cells, then secondary for three, then accent.
    const line = (theme: string, shade: ShadeName, count: number): { entries: DecorEntry[]; drawn: string[] } => {
      const palette = getThemePalette(theme)!;
      const entries = Array.from({ length: count }, (_, i) => decorEntryFor(palette, { variation: VARIATIONS.alt, shade: SHADES[shade] }, [row(1, 2), cell(i, count)], ansi));
      return { entries, drawn: entries.map((entry) => shown(decorEntryColour(palette, entry)).hex) };
    };
    // catppuccin-frappe: the accent after the second turn is dealt silver
    // beside the secondary's silver, and its window's white stands apart
    // from it.
    const frappe = line("catppuccin-frappe", "middle", 7);
    expect(frappe.entries[6]).toEqual({ hue: "accent", shade: "lighten-1" });
    expect(frappe.drawn.slice(5)).toEqual(["#c0c0c0", "#ffffff"]);
    // The secondary after the first turn is dealt silver beside the accent's
    // silver, and its window's other tone is the grey of the cell after it,
    // so it takes the nearest rung of its ladder drawn as neither: olive. Its
    // ladder draws three slots at ansi, so its window holds two of them and
    // leaves olive, the last, to the press. Only a window of two tones can
    // be spent this way: two neighbours take at most two of a window's
    // colours, so a window holding three always has one to give.
    expect(frappe.entries[3]).toEqual({ hue: "secondary", shade: "darken-3" });
    expect(frappe.drawn.slice(2, 5)).toEqual(["#c0c0c0", "#808000", "#808080"]);
    expect(windowAt(getThemePalette("catppuccin-frappe"), "secondary", SHADES.middle, ansi)).toEqual(["darken-1", "lighten-1"]);
    // textual-ansi on the muted dial: the secondary's whole ladder and the
    // accent's muted form are teal, and the accent's ladder is blue. The
    // secondary after the turn has teal alone, and the accent before it has
    // blue beside it on its other side: neither has a rung to give.
    expect(line("textual-ansi", "muted", 5).drawn).toEqual(["#008080", "#0000ff", "#008080", "#008080", "#008080"]);
  });

  test("a cell moved at a turn keeps off the shade an open trigger on the bar wears: past a tone of its window drawn like it, and where the cell after the turn has nothing apart from both neighbours and the press, the cell before the turn moves", () => {
    const ansi = ColorDepth.STANDARD;
    const shown = shownAt(ansi);
    const moon = getThemePalette("rose-pine-moon");
    const drawnLine = (variation: VariationName, shade: ShadeName, count: number) => {
      const decor: Decor = { variation: VARIATIONS[variation], shade: SHADES[shade] };
      const entries = Array.from({ length: count }, (_, i) => decorEntryFor(moon, decor, [row(1, 2), cell(i, count)], ansi));
      return {
        entries,
        drawn: entries.map((entry) => shown(decorEntryColour(moon, entry)).hex),
        pressed: shown(bandFor(moon, { decor, depth: 0 }, ansi).state).hex,
      };
    };
    // On the muted dial under end-secondary, the line-end keystone is dealt
    // its accent's muted grey beside the secondary's grey. Its window's other
    // tone, the accent itself, draws silver, which is what an open trigger
    // wears there (the dial's pressed rung, the secondary's second
    // lightening), so it passes that tone over for its ladder's white.
    const end = drawnLine("end-secondary", "muted", 3);
    expect(windowAt(moon, "accent", SHADES.muted, ansi)).toEqual(["muted", "base"]);
    expect(end.pressed).toBe("#c0c0c0");
    expect(end.entries[2]).toEqual({ hue: "accent", shade: "lighten-3" });
    expect(end.drawn).toEqual(["#008080", "#808080", "#ffffff"]);
    // Under alt, the accent after the second row's turn is dealt grey beside
    // the secondary's grey, and its ladder draws grey, silver and white: its
    // neighbours wear the first two and an open trigger the third. So the
    // secondary before the turn moves, to its silver, past its window and
    // apart from the teal and grey beside it and from the press.
    const alt = drawnLine("alt", "middle", 8);
    expect(alt.pressed).toBe("#ffffff");
    expect(alt.entries.slice(5, 7)).toEqual([
      { hue: "secondary", shade: "lighten-2" },
      { hue: "accent", shade: "darken-1" },
    ]);
    expect(alt.drawn.slice(4, 8)).toEqual(["#008080", "#c0c0c0", "#808080", "#c0c0c0"]);
  });
});

describe("distributions", () => {
  test("van der Corput is bit reversal and reads no count", () => {
    const vdc = DISTRIBUTIONS["van-der-corput"];
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => vdc.place(i, 8))).toEqual([
      0, 0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875,
    ]);
  });

  test("n-free distributions ignore the count; n-reading ones use it", () => {
    for (let index = 0; index < 8; index++) {
      for (const name of N_FREE) {
        expect(DISTRIBUTIONS[name].place(index, 8)).toBe(DISTRIBUTIONS[name].place(index, 20));
      }
    }
    for (const name of N_READING) {
      expect(DISTRIBUTIONS[name].place(1, 8)).not.toBe(DISTRIBUTIONS[name].place(1, 20));
    }
  });

  test("every distribution lands in [0, 1) for every legal (index, count)", () => {
    for (const name of ALL_NAMES) {
      for (let count = 1; count <= 12; count++) {
        for (let index = 0; index < count; index++) {
          const v = DISTRIBUTIONS[name].place(index, count);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
        }
      }
    }
  });
});

describe("done-when: any node's colour is computable alone", () => {
  test("visiting order and visited set do not change a node's colour", () => {
    for (const name of ALL_NAMES) {
      const distribution = DISTRIBUTIONS[name];
      for (const { seed, shape } of SHAPES) {
        const rng = seededRng(seed);
        const nodes = allNodes(shape, distribution);
        const inOrder = colourMap(shape, distribution);
        // A single node, evaluated with no other node ever visited.
        const lone = drawFrom(rng, nodes);
        expect([name, seed, decorFor(DRACULA, TWO_STEP, lone.address, AT).hex]).toEqual([
          name,
          seed,
          inOrder.get(pathKey(lone.path)),
        ]);
        // The whole tree, evaluated back to front — a walk cursor would diverge here.
        for (const { path, address } of [...nodes].reverse()) {
          expect(decorFor(DRACULA, TWO_STEP, address, AT).hex).toBe(inOrder.get(pathKey(path)));
        }
      }
    }
  });
});

describe("done-when: adding a sibling", () => {
  test("changes no existing node under the n-free distributions", () => {
    for (const name of N_FREE) {
      const distribution = DISTRIBUTIONS[name];
      for (const { seed, shape } of SHAPES) {
        const rng = seededRng(seed);
        const nodes = allNodes(shape, distribution);
        const target = drawFrom(rng, nodes).path;
        const before = colourMap(shape, distribution);
        const after = colourMap(withSiblingAdded(shape, target), distribution);
        for (const [key, hex] of before) {
          expect([name, seed, key, after.get(key)]).toEqual([name, seed, key, hex]);
        }
      }
    }
  });

  test("re-spaces existing siblings under the n-reading distributions (the trade is real)", () => {
    // Read by equal bins, an even spread keeps its ends where they were, so a
    // re-spacing need not reach a colour at every parent: each shape's parents
    // are tried in tree order until one does.
    for (const name of N_READING) {
      const distribution = DISTRIBUTIONS[name];
      let moved = 0;
      for (const { shape } of SHAPES) {
        const parents = allNodes(shape, distribution).filter(({ path }) => nodeAt(shape, path).children.length >= 2);
        const before = colourMap(shape, distribution);
        for (const { path } of parents) {
          const after = colourMap(withSiblingAdded(shape, path), distribution);
          for (const [key, hex] of before) if (after.get(key) !== hex) moved++;
          if (moved > 0) break;
        }
      }
      expect([name, moved > 0]).toEqual([name, true]);
    }
  });
});

describe("done-when: permuting an unrelated subtree", () => {
  test("leaves every node outside it byte-identical, under every distribution", () => {
    for (const name of ALL_NAMES) {
      const distribution = DISTRIBUTIONS[name];
      for (const { seed, shape } of SHAPES) {
        const rng = seededRng(seed);
        // Below the root only: permuting the root's children leaves no node outside.
        const parents = allNodes(shape, distribution).filter(
          ({ path }) => path.length > 0 && nodeAt(shape, path).children.length >= 2,
        );
        if (parents.length === 0) continue;
        const target = drawFrom(rng, parents).path;
        const before = colourMap(shape, distribution);
        const after = colourMap(withChildrenPermuted(shape, target, rng), distribution);
        for (const { path } of allNodes(shape, distribution)) {
          if (isUnder(target, path) && path.length > target.length) continue;
          const key = pathKey(path);
          expect([name, seed, key, after.get(key)]).toEqual([name, seed, key, before.get(key)]);
        }
      }
    }
  });
});

describe("done-when: a vocabulary of size 1 is a uniform bar", () => {
  test("every address selects the one entry under every distribution", () => {
    const only = { hue: "primary", shade: "muted" } as const;
    // The selector reads one step, so the sweep is over the distinct steps
    // the addresses hold, not the addresses: a few dozen, where every node of
    // every shape under every distribution is a hundred thousand repeats. A
    // step is keyed by exactly what the selector reads of it — its
    // distribution, by name, at its index of its count — so no field a step
    // grows can fold two steps the selector tells apart into one.
    const steps = new Map<string, PlacedStep | undefined>([["", undefined]]);
    for (const name of ALL_NAMES) {
      for (const { shape } of SHAPES) {
        for (const { address } of allNodes(shape, DISTRIBUTIONS[name])) {
          for (const step of address) steps.set(`${name}:${step.index}/${step.count}`, step);
        }
      }
    }
    expect(steps.size).toBeGreaterThan(ALL_NAMES.length);
    for (const step of steps.values()) {
      expect(vocabularySelect([only], step)).toBe(only);
    }
  });

  test("an empty vocabulary has nothing to select and says so, under every distribution", () => {
    expect(() => vocabularySelect([], undefined)).toThrow(/empty vocabulary/);
    for (const name of ALL_NAMES) {
      expect(() => vocabularySelect([], { index: 1, count: 2, distribution: DISTRIBUTIONS[name] })).toThrow(/empty vocabulary/);
    }
  });
});


describe("depth steps along the lineage", () => {
  test("each depth wears the next hue of the lineage, wrapping; a one-hue lineage keeps it", () => {
    const today: Lineage = ["accent", "primary", "secondary"];
    expect([0, 1, 2, 3].map((depth) => lineageHue(today, depth))).toEqual(["accent", "primary", "secondary", "accent"]);
    expect([0, 1, 2, 3].map((depth) => lineageHue(["primary", "secondary"], depth))).toEqual(["primary", "secondary", "primary", "secondary"]);
    expect([0, 1, 2, 3].map((depth) => lineageHue(["primary"], depth))).toEqual(["primary", "primary", "primary", "primary"]);
    // The shipped rows open as the bar did before the tunings; a tuning as
    // its name says.
    expect(VARIATIONS.accent.open).toEqual(today);
    expect(VARIATIONS["ends-alternate"].open).toEqual(["primary", "secondary"]);
  });
});

describe("a band item is placed by its step", () => {
  test("an item wears one of its band's items — the band's hue at a tone of the dial's window — picked by the step that places it along its row, as a bar cell picks its shade", () => {
    const at = (index: number, count: number): PlacedStep => ({ index, count, distribution: VDC });
    for (const shade of SHADE_NAMES) {
      const decor: Decor = { variation: VARIATIONS["ends-primary"], shade: SHADES[shade] };
      const disclosure: Disclosure = { decor, depth: 0 };
      // A bar row in the band's own hue, to pick a shade as the band picks an item.
      const inPrimary: Decor = { variation: VARIATIONS.mono, shade: SHADES[shade] };
      for (const palette of REGISTRY) {
        const tones = windowAt(palette, "primary", SHADES[shade], AT);
        const { items } = bandFor(palette, disclosure, AT);
        // The items are the lineage's hue at each tone of its window, as the palette names it.
        expect(items.map((c) => c.hex)).toEqual(tones.map((tone) => palette.get(shadeRole("primary", tone)).hex));
        const item = (place: PlacedStep | undefined) =>
          bandItemFor(palette, disclosure, place, AT).hex;
        const inBand = (address: Address) =>
          decorationFor(palette, { kind: "band", band: disclosure, address }, AT).tint.hex;
        // A cell picks its item as a bar cell of its hue at that place picks its shade.
        const expected = (index: number): string =>
          items[tones.indexOf(decorEntryFor(palette, inPrimary, [cell(index, index + 1)], AT).shade)]!.hex;
        for (const count of [2, 5, 12]) {
          const cells = Array.from({ length: count }, (_, index) => item(at(index, count)));
          expect(cells).toEqual(cells.map((_, index) => expected(index)));
        }
        // A cell of a row inside a body is picked by its cell, not its row:
        // rows 0 and 1 of a body deal their cells alike.
        for (const r of [0, 1]) {
          expect([0, 1, 2].map((c) => inBand([row(r, 2), cell(c, 3)]))).toEqual([0, 1, 2].map(expected));
        }
        // Edit chrome wraps every content cell of a user's body in a unit (✚,
        // label, the cell, ✚) that shares the cell's place, so each wears that
        // cell's item; a group's leaves take places along the row as its own
        // cells do.
        expect([0, 1, 2].map((c) => inBand([cell(c, 3), cell(c, 3)]))).toEqual([0, 1, 2].map(expected));
        expect([1, 2].map((c) => inBand([row(0, 1), cell(1, 3), cell(c, 3)]))).toEqual([1, 2].map(expected));
        // A row picks nothing: a segment that is a row by itself is a first
        // cell, as edit chrome's one-cell row around it is.
        expect([0, 1].map((r) => inBand([row(r, 2)]))).toEqual([expected(0), expected(0)]);
        expect([0, 1].map((r) => inBand([row(r, 2), cell(0, 1), cell(0, 1)]))).toEqual([expected(0), expected(0)]);
        // A body that is one segment is a first item, beside its ✕.
        expect(inBand([])).toBe(expected(0));
        expect(item(undefined)).toBe(expected(0));
        // A picker's option is its index over the whole domain: the page it is
        // drawn on (the count it is placed among) never recolours it.
        expect(item(at(7, 8))).toBe(item(at(7, 40)));
      }
    }
  });

  test("a band item's text is what the dial pairs with its shade, as a bar cell's is", () => {
    for (const shade of ["middle", "muted"] as const) {
      const decor: Decor = { variation: VARIATIONS["ends-primary"], shade: SHADES[shade] };
      const disclosure: Disclosure = { decor, depth: 0 };
      for (const palette of REGISTRY) {
        const { tint, text } = decorationFor(palette, { kind: "band", band: disclosure, address: [] }, ColorDepth.TRUECOLOR);
        expect([palette.name, shade, text.hex]).toEqual([palette.name, shade, SHADES[shade].text(palette, "primary", tint, ColorDepth.TRUECOLOR).hex]);
      }
    }
  });
  test("a picker's option wears what a segment at its step wears, text and all, so one menu's items read alike", () => {
    for (const shade of ["middle", "muted"] as const) {
      const decor: Decor = { variation: VARIATIONS["ends-primary"], shade: SHADES[shade] };
      const disclosure: Disclosure = { decor, depth: 0 };
      for (const palette of REGISTRY) {
        // The option's style reads the active segment's palette and the band it opens, nothing else.
        const active = { palette, disclosure } as ActiveSegment;
        for (const index of [0, 1, 2]) {
          const option = bandItemStyle(active, { index, count: 3, distribution: VDC }, ColorDepth.TRUECOLOR);
          const segment = decorationFor(palette, { kind: "band", band: disclosure, address: [cell(index, 3)] }, ColorDepth.TRUECOLOR);
          expect([palette.name, shade, index, option.bgcolor?.value?.hex, option.color?.value?.hex]).toEqual([
            palette.name,
            shade,
            index,
            segment.tint.hex,
            segment.text.hex,
          ]);
        }
      }
    }
  });
});

describe("an open menu wears shades its theme names, selected and never searched", () => {
  // A palette entry in the test's own words: the role, suffixed by its shade.
  const named = (hue: DecorHue, shade: RoleShade): string => (shade === "base" ? hue : `${hue}-${shade}`);
  // Every lineage a shipped variation opens, once.
  const LINEAGES: readonly Lineage[] = [
    ...new Map(VARIATION_NAMES.map((name) => [VARIATIONS[name].open.join(","), VARIATIONS[name].open] as const)).values(),
  ];

  test("the dial names the shade a pressed button wears: the role's muted form on every window of the ladder, its second lightening where the row is already muted", () => {
    expect(SHADES.muted.activated).toBe("lighten-2");
    for (const name of SHADE_NAMES.filter((shade) => shade !== "muted")) {
      expect([name, SHADES[name].activated]).toEqual([name, "muted"]);
    }
    // A pressed button wears a shade its position never deals, so it stands
    // out of the row it is pressed in.
    for (const name of SHADE_NAMES) {
      const tones: readonly RoleShade[] = SHADES[name].tones;
      expect([name, tones.includes(SHADES[name].activated)]).toEqual([name, false]);
    }
  });

  // [LAW:verifiable-goals] candybar-joiners-e5r4.686: a pressed shade stands
  // beside its own band's items (its ✕ and leads open each row), beside
  // whatever its trigger stands among (the bar's cells, or the band one depth
  // up: its items and its leads), and so beside the pressed shade one depth up.
  test("a pressed button wears the dial's shade where the depth draws it apart from all that stands beside it, else the nearest rung that is, and keeps the dial's shade only where the role's whole ladder has none", () => {
    const wrong: string[] = [];
    const seen = { kept: 0, widened: 0, none: 0 };
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      for (const palette of REGISTRY) {
        const drawn = (hue: DecorHue, tone: RoleShade): string => shown(palette.get(shadeRole(hue, tone))).hex;
        for (const name of VARIATION_NAMES) {
          const variation = VARIATIONS[name];
          for (const shade of SHADE_NAMES) {
            const decor: Decor = { variation, shade: SHADES[shade] };
            for (const depth of [0, 1, 2, 3]) {
              const hue = lineageHue(variation.open, depth);
              const taken = besidePress(palette, decor, depth, drawnAt);
              const { activated } = SHADES[shade];
              const apart = [activated, ...nearestFrom([activated], palette.dark)].filter((tone) => !taken.has(drawn(hue, tone)));
              const pressed = pressedAt(palette, { decor, depth }, drawnAt);
              const expected = apart[0] ?? activated;
              if (pressed !== expected)
                wrong.push(`${palette.name} ${name}/${shade} depth ${depth} at ${ColorDepth[drawnAt]}: ${pressed}, expected ${expected}`);
              seen[apart.length === 0 ? "none" : expected === activated ? "kept" : "widened"]++;
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect([seen.kept > 0, seen.widened > 0]).toEqual([true, true]);
    // A ladder with nothing left to give is a sixteen-colour fact, or a flat
    // ladder's: at truecolor and 256 colours only textual-ansi's.
    for (const drawnAt of [ColorDepth.TRUECOLOR, ColorDepth.EIGHT_BIT]) {
      const shown = shownAt(drawnAt);
      for (const palette of REGISTRY.filter((p) => p.name !== "textual-ansi")) {
        for (const depth of [0, 1, 2]) {
          const disclosure: Disclosure = { decor: TODAY, depth };
          const { state, items } = bandFor(palette, disclosure, drawnAt);
          expect([palette.name, depth, items.map((item) => shown(item).hex).includes(shown(state).hex)]).toEqual([palette.name, depth, false]);
        }
      }
    }
  });

  test("under a one-hue lineage each depth's pressed shade is drawn apart from the one above it, wherever the ladder has a rung to give: door-primary on nord", () => {
    const nord = getThemePalette("nord");
    const decor: Decor = { variation: VARIATIONS["door-primary"], shade: SHADES[floorOf("shade")] };
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      const pressed = [0, 1, 2, 3].map((depth) => shown(bandFor(nord, { decor, depth }, drawnAt).state).hex);
      // One hue at every depth, so every depth's band presses into one ladder.
      expect([0, 1, 2, 3].map((depth) => hueOf({ decor, depth }))).toEqual(["primary", "primary", "primary", "primary"]);
      for (const depth of [1, 2, 3]) {
        const ladderHasOne = LADDER.some((r) => {
          const c = shown(nord.get(shadeRole("primary", r))).hex;
          return c !== pressed[depth - 1] && !windowAt(nord, "primary", decor.shade, drawnAt).some((t) => shown(nord.get(shadeRole("primary", t))).hex === c);
        });
        if (ladderHasOne) expect([ColorDepth[drawnAt], depth, pressed[depth]]).not.toEqual([ColorDepth[drawnAt], depth, pressed[depth - 1]]);
      }
    }
    // In truecolor the ladder always has one.
    const truecolor = [0, 1].map((depth) => bandFor(nord, { decor, depth }, AT).state.hex);
    expect(truecolor[1]).not.toBe(truecolor[0]);
  });

  test("the activated segment wears its menu's hue at its pressed shade, the plane is the theme's surface at every depth, and the items are the hue at the window's tones, byte for byte as the palette names each", () => {
    for (const palette of REGISTRY) {
      for (const shade of SHADE_NAMES) {
        for (const open of LINEAGES) {
          const decor: Decor = { variation: { ...TODAY.variation, open }, shade: SHADES[shade] };
          for (const depth of [0, 1, 2, 3, 4]) {
            const hue = lineageHue(open, depth);
            const { state, plane, items } = bandFor(palette, { decor, depth }, AT);
            const where = [palette.name, shade, open.join(","), depth];
            expect([...where, state.hex, plane.hex, items.map((c) => c.hex)]).toEqual([
              ...where,
              palette.get(named(hue, pressedAt(palette, { decor, depth }, AT)))!.hex,
              palette.get("surface")!.hex,
              windowAt(palette, hue, SHADES[shade], AT).map((tone) => palette.get(named(hue, tone))!.hex),
            ]);
          }
        }
      }
    }
  });

  test("text on every cell an open menu draws clears TEXT_MIN_CONTRAST as drawn, at truecolor, 256 colours and ansi", () => {
    const wrong: string[] = [];
    let measured = 0;
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      for (const palette of REGISTRY) {
        for (const shade of SHADE_NAMES) {
          for (const hue of DECOR_HUES) {
            const disclosure: Disclosure = {
              decor: { variation: { ...TODAY.variation, open: [hue] }, shade: SHADES[shade] },
              depth: 0,
            };
            const { state, plane } = bandFor(palette, disclosure, drawnAt);
            const active = { palette, disclosure } as ActiveSegment;
            // The activated segment and the blank leads wear `state` under the
            // text chosen for it; the ✕ leading a row wears it under the close
            // glyph's; the plane carries a picker's ✕ and the text of a list
            // drawn on it; the items are dealt along a row.
            const cells: ReadonlyArray<readonly [string, Style]> = [
              ["activated", stateCell(palette, state, drawnAt)],
              ["✕", closeCell(palette, state, drawnAt)],
              ["plane", stateCell(palette, plane, drawnAt)],
              ["✕ on the plane", Style.combine([stateCell(palette, plane, drawnAt), closeOn(palette, plane, drawnAt)])],
              ...Array.from(
                { length: 8 },
                (_, index) => [`item ${index}`, bandItemStyle(active, { index, count: 8, distribution: VDC }, drawnAt)] as const,
              ),
            ];
            for (const [cell, style] of cells) {
              measured++;
              const ratio = contrastRatio(shown(style.color!.value!), shown(style.bgcolor!.value!));
              if (ratio < TEXT_MIN_CONTRAST) {
                wrong.push(`${palette.name} ${shade} ${hue} ${cell} at ${ColorDepth[drawnAt]}: ${ratio.toFixed(2)}`);
              }
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(measured).toBe(DRAWN.length * REGISTRY.length * SHADE_NAMES.length * DECOR_HUES.length * 12);
  });
});
