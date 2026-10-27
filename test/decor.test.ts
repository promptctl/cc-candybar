// [LAW:verifiable-goals] candybar-render-ai7.1: the colour function. Each
// `describe` is one line of the ticket's Done-when, pinned as a property over
// generated tree SHAPES (test/helpers/seeded-trees.ts), not over hand-picked
// branches. [LAW:behavior-not-structure] Every assertion is about bytes out
// for addresses in; a different implementation of the same contract passes.
// candybar-theme-colours-6fq5.e5n: a closed cell wears its role at a shade the
// palette names, through the shade dial, and an open trigger stands off the
// row it stands in.

import { ColorDepth, drawnColour } from "@promptctl/rich-js";
import {
  ColorRgba,
  contrastRatio,
  getThemePalette,
  listThemePalettes,
  Palette,
} from "@promptctl/rich-js";
import { floorOf } from "../src/config/globals-fields";
import {
  BAND_FLOORS,
  deltaE,
  VARIATIONS,
  SHADES,
  DECOR_HUES,
  KEYSTONE_HUE,
  QUANTIZE,
  DISTRIBUTIONS,
  STATE_FLOOR,
  bandFor,
  bandItemFor,
  decorEntryColour,
  decorEntryFor,
  decorFor,
  decorationFor,
  bandEntries,
  hueOf,
  lineageHue,
  paletteRole,
  rowGround,
  shadeRole,
  vocabularyOf,
  vocabularySelect,
  inBin,
  nearestPoint,
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
import { DRAWN, FIRST_ROW, REGISTRY, SHADE_NAMES, TODAY, VARIATION_NAMES, VDC, cell, row } from "./helpers/decor-vocabulary";

const DRACULA = getThemePalette("dracula");
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
      decorFor(DRACULA, TWO_STEP, address).hex,
    ]),
  );
}


// Textual's ladder for a role, darkest first — the rungs the dial's windows
// slide along, spelled here in the test's own words.
const LADDER: readonly RoleShade[] = [
  "darken-3",
  "darken-2",
  "darken-1",
  "base",
  "lighten-1",
  "lighten-2",
  "lighten-3",
];
const rung = (shade: RoleShade): number => LADDER.indexOf(shade);

describe("the shade dial", () => {
  // The dial's positions, lowest first; the jump candidates of
  // brandon-menus-sjhy.4fi follow them in the table.
  const DIAL = ["muted", "deepest", "deeper", "middle", "brighter", "brightest"] as const;

  test("runs muted, then a window of three rungs from the deepest to the brightest, each one rung above the last", () => {
    expect(SHADE_NAMES.slice(0, DIAL.length)).toEqual([...DIAL]);
    expect(SHADES.muted.tones).toEqual(["muted"]);
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

  test("a jump candidate is the role's window widened, or two tones the whole width apart, each read by the rule under which neighbours never share a tone", () => {
    expect(SHADES.wide.tones.map(rung).sort()).toEqual([1, 3, 5]);
    expect(SHADES.widest.tones.map(rung).sort()).toEqual([0, 3, 6]);
    expect(SHADES.pair.tones.map(rung).sort()).toEqual([1, 5]);
    expect(SHADES["pair-wide"].tones.map(rung).sort()).toEqual([0, 6]);
    // Over three tones the nearest point keeps van der Corput's neighbours
    // apart; over two, the bin does — and every row of the table says which.
    for (const name of SHADE_NAMES) {
      const { tones, quantize } = SHADES[name];
      const picks = Array.from({ length: 8 }, (_, index) => QUANTIZE[quantize](VDC(index, 8), tones.length));
      const alike = picks.slice(1).filter((pick, i) => tones.length > 1 && pick === picks[i]);
      expect([name, alike]).toEqual([name, []]);
    }
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
      Array.from({ length: count }, (_, i) => decorEntryFor(under(name), [row(r, 2), cell(i, count)]).hue);
    expect(hues("ends-primary", 0, 4)).toEqual(["accent", "secondary", "secondary", "accent"]);
    expect(hues("ends-primary", 1, 3)).toEqual(["accent", "secondary", "accent"]);
    expect(hues("start-primary", 1, 3)).toEqual(["accent", "secondary", "secondary"]);
    expect(hues("end-primary", 1, 3)).toEqual(["secondary", "secondary", "accent"]);
    // The bar's first cell alone: the first cell of the first row.
    expect(hues("door-primary", 0, 3)).toEqual(["accent", "secondary", "secondary"]);
    expect(hues("door-primary", 1, 3)).toEqual(["secondary", "secondary", "secondary"]);
    // A keystone's shade is its place's, like any cell's.
    for (const i of [0, 3]) {
      expect(decorEntryFor(under("ends-primary"), [row(0, 2), cell(i, 4)]).shade).toBe(
        decorEntryFor(under("mono"), [row(0, 2), cell(i, 4)]).shade,
      );
    }
    // A node alone on the cell axis is its line's first cell and its last.
    expect(decorEntryFor(under("end-primary"), [row(1, 2)]).hue).toBe("accent");
    expect(decorEntryFor(under("start-primary"), [row(1, 2)]).hue).toBe("accent");
    // What is nested inside a keystone cell wears it.
    expect(decorEntryFor(under("ends-primary"), [row(0, 2), cell(3, 4), cell(1, 3)]).hue).toBe("accent");
    // The ground of a keystone row carries the accent entry its keystone wears.
    expect(rowGround(under("ends-primary"), [row(0, 2), cell(0, 4)])).toContainEqual({ hue: "accent", shade: decorEntryFor(under("ends-primary"), [row(0, 2), cell(3, 4)]).shade });
  });

  test("every shipped theme carries every role the vocabulary names", () => {
    for (const name of listThemePalettes()) {
      const palette = getThemePalette(name);
      const roles = [
        "foreground",
        "background",
        "warning",
        "error",
        ...DECOR_HUES.flatMap((hue) => [
          `text-${hue}` as const,
          ...SHADE_NAMES.flatMap((shade) => SHADES[shade].tones.map((tone) => shadeRole(hue, tone))),
        ]),
      ] as const;
      for (const role of roles) expect(() => paletteRole(palette, role)).not.toThrow();
    }
  });

  test("a palette missing a role fails loudly, naming palette and role", () => {
    const bare = new Palette("bare", true, new Map<string, ColorRgba>());
    expect(() => paletteRole(bare, "accent")).toThrow(/"bare".*"accent"/);
    expect(() => decorFor(bare, TWO_STEP, [])).toThrow(/"bare"/);
  });
});

describe("the colour is its role at a shade, as the palette names it", () => {
  test("byte for byte the palette's own entry, for every theme, shade and role", () => {
    for (const name of listThemePalettes()) {
      const palette = getThemePalette(name);
      for (const shade of SHADE_NAMES) {
        for (const entry of vocabularyOf({ variation: VARIATIONS.duo, shade: SHADES[shade] })) {
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
    // Row 1 of 2 (vdc 0.5 × 2 = 1 -> secondary), cell 3 of 6 (vdc 0.75 × 3 =
    // 2.25 -> entry 2 of the middle window, the role itself).
    expect(decorEntryFor(TWO_STEP, [row(1, 2), cell(3, 6)])).toEqual({ hue: "secondary", shade: "base" });
    // Only the innermost row counts: a row stacked above the whole bar (edit
    // mode's reset banner wraps the content as row 1 of 2) recolours nothing.
    expect(decorEntryFor(TWO_STEP, [row(1, 2), row(0, 2), cell(3, 6)])).toEqual({ hue: "primary", shade: "base" });
    // Anything nested inside a cell wears the cell's hue and shade: edit
    // mode's `+`/`-` wrap each content cell as the middle of three, and a `{ v }`
    // inside a cell stacks rows that are not the bar's.
    for (const nested of [[cell(1, 3)], [row(0, 2)], [row(0, 2), cell(2, 3)]]) {
      expect(decorEntryFor(TWO_STEP, [row(1, 2), cell(3, 6), ...nested])).toEqual(
        decorEntryFor(TWO_STEP, [row(1, 2), cell(3, 6)]),
      );
    }
    // A bar with no vertical container is one row, in the first bar hue.
    expect(decorEntryFor(TWO_STEP, [cell(1, 4)])).toEqual({ hue: TWO_STEP.variation.hues[0], shade: "base" });
  });

  test("the shade step is placed by its OWN distribution", () => {
    // Cell 1 of 4: vdc 0.5 × 3 = 1.5 -> entry 2; monotonic 0.375 × 3 = 1.125 -> entry 1.
    expect(decorEntryFor(TWO_STEP, [cell(1, 4)]).shade).toBe(SHADES.middle.tones[2]);
    expect(
      decorEntryFor(TWO_STEP, [{ ...cell(1, 4), distribution: DISTRIBUTIONS.monotonic }]).shade,
    ).toBe(SHADES.middle.tones[1]);
  });

  test("a row walks up and down its window a rung at a time, never two cells side by side alike", () => {
    // Van der Corput lands a row's first eight cells on entries 0, 2, 1, 2, 0,
    // 2, 1, 0 of three; the window is listed low, high, middle, so the row reads
    // low, middle, high, middle, low, middle, high, low.
    const walk = (shade: ShadeName): RoleShade[] =>
      [0, 1, 2, 3, 4, 5, 6, 7].map(
        (i) => decorEntryFor({ ...TWO_STEP, shade: SHADES[shade] }, [row(0, 2), cell(i, 8)]).shade,
      );
    for (const shade of ["deepest", "deeper", "middle", "brighter", "brightest"] as const) {
      const low = rung(SHADES[shade].tones[0]);
      expect([shade, walk(shade).map((s) => rung(s) - low)]).toEqual([shade, [0, 1, 2, 1, 0, 1, 2, 0]]);
    }
    // Every window, under its own rule: the tone its placement picks, and
    // never the tone of the cell before it.
    for (const shade of SHADE_NAMES) {
      const { tones, quantize } = SHADES[shade];
      if (tones.length === 1) continue;
      const shades = walk(shade);
      expect([shade, shades]).toEqual([shade, shades.map((_, i) => tones[QUANTIZE[quantize](VDC(i, 8), tones.length)])]);
      expect([shade, shades.filter((s, i) => i > 0 && s === shades[i - 1])]).toEqual([shade, []]);
    }
  });

  test("a muted row is one colour: every cell wears its role's muted form", () => {
    const muted: Decor = { ...TWO_STEP, shade: SHADES.muted };
    for (const r of [0, 1]) {
      const shades = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => decorEntryFor(muted, [row(r, 2), cell(i, 8)]));
      expect(new Set(shades.map((e) => `${e.hue}|${e.shade}`)).size).toBe(1);
      expect(shades[0]!.shade).toBe("muted");
    }
  });

  test("no two rows side by side share a hue", () => {
    // Rows land at 0, ½, ¼, ¾, … and a row's hue is the half it falls in, so
    // the first bit alternates them however many rows the bar stacks.
    const hues = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => decorEntryFor(TWO_STEP, [row(i, 8)]).hue);
    expect(hues).toEqual(Array.from({ length: 8 }, (_, i) => TWO_STEP.variation.hues[i % 2]));
  });

  test("row n wears step n of every variation, and a one-step variation is uniform", () => {
    for (const name of VARIATION_NAMES) {
      const decor = decorWith(VARIATIONS[name]);
      const steps: readonly string[] = decor.variation.hues;
      // The middle cell of three: no keystone place, so the row's stepped hue.
      const hues = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => decorEntryFor(decor, [row(i, 8), cell(1, 3)]).hue);
      expect([name, hues]).toEqual([name, Array.from({ length: 8 }, (_, i) => steps[i % steps.length])]);
    }
    // The shade is the variation's business nowhere: the cell alone picks it.
    for (const name of VARIATION_NAMES) {
      expect(decorEntryFor(decorWith(VARIATIONS[name]), [row(1, 2), cell(3, 6)]).shade).toBe("base");
    }
  });

  test("a whole-row variation keeps one hue across a row; alt steps it every three cells", () => {
    const along = (variation: Variation, r: number) =>
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => decorEntryFor(decorWith(variation), [row(r, 2), cell(i, 8)]).hue);
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
    const shades = [0, 1, 2].map((i) => decorEntryFor(decorWith(VARIATIONS.alt), [row(0, 2), cell(i, 8)]).shade);
    expect(new Set(shades).size).toBe(3);
  });

  test("anything nested inside an alt cell wears that cell's hue", () => {
    const alt = decorWith(VARIATIONS.alt);
    for (const nested of [[cell(0, 3)], [cell(2, 3)], [row(1, 2), cell(1, 3)]]) {
      expect(decorEntryFor(alt, [row(0, 2), cell(4, 8), ...nested])).toEqual(
        decorEntryFor(alt, [row(0, 2), cell(4, 8)]),
      );
    }
  });

  test("a stack of rows inside a row restarts the alternation: siblings alternate, not lines", () => {
    // root { v: [ { v: [x, y] }, z ] }: y is the second of its stack, z the
    // second of the bar's, so the two lines touch in one hue. Stated, not
    // hidden — see decorEntryFor.
    expect(decorEntryFor(TWO_STEP, [row(0, 2), row(1, 2)]).hue).toBe(decorEntryFor(TWO_STEP, [row(1, 2)]).hue);
  });

  test("the root selects the variation's first step at the shade's first entry — or the keystone hue, being the bar's first cell and its last", () => {
    // The empty address has no step to place, so no distribution can reach it.
    for (const name of VARIATION_NAMES) {
      for (const shade of SHADE_NAMES) {
        const decor: Decor = { variation: VARIATIONS[name], shade: SHADES[shade] };
        const hue = VARIATIONS[name].keystones.length === 0 ? VARIATIONS[name].hues[0] : KEYSTONE_HUE;
        expect(decorEntryFor(decor, [])).toEqual({ hue, shade: SHADES[shade].tones[0] });
      }
    }
  });

  test("a row's ground is the entries its cells wear, each once — every cell as decorEntryFor reads it", () => {
    const at = (name: VariationName): Decor => ({ variation: VARIATIONS[name], shade: SHADES.middle });
    const worn = (name: VariationName, r: number, count: number) => rowGround(at(name), [row(r, 2), cell(0, count)]);
    const entry = (hue: DecorHue, shade: RoleShade): DecorEntry => ({ hue, shade });
    // A row of one wears what a first cell does, and nothing else; two cells
    // take two of the window's three shades.
    expect(worn("accent", 0, 1)).toEqual([entry("secondary", "darken-1")]);
    expect(worn("accent", 0, 2)).toEqual([entry("secondary", "darken-1"), entry("secondary", "base")]);
    expect(worn("accent", 1, 8)).toEqual([entry("accent", "darken-1"), entry("accent", "base"), entry("accent", "lighten-1")]);
    // A row of one run never turns; a longer one turns to the other role for
    // the cells it has past the run, at the shades those cells take.
    expect(worn("alt", 1, 3)).toEqual([entry("accent", "darken-1"), entry("accent", "base"), entry("accent", "lighten-1")]);
    expect(worn("alt", 0, 4)).toEqual([
      entry("secondary", "darken-1"),
      entry("secondary", "base"),
      entry("secondary", "lighten-1"),
      entry("accent", "base"),
    ]);
    // Anything nested in a cell stands in that cell's row.
    expect(rowGround(at("alt"), [row(0, 2), cell(0, 8), cell(1, 3)])).toEqual(worn("alt", 0, 8));
    // Under every shipped decor, at either start and every length: each
    // cell's own entry, and nothing else.
    const key = (e: DecorEntry): string => shadeRole(e.hue, e.shade);
    for (const variation of VARIATION_NAMES) {
      for (const shade of SHADE_NAMES) {
        const decor: Decor = { variation: VARIATIONS[variation], shade: SHADES[shade] };
        for (const r of [0, 1]) {
          for (let count = 1; count <= 12; count++) {
            const cells = Array.from({ length: count }, (_, i) => key(decorEntryFor(decor, [row(r, 2), cell(i, count)])));
            const ground = rowGround(decor, [row(r, 2), cell(0, count)]).map(key);
            expect([variation, shade, r, count, [...ground].sort()]).toEqual([variation, shade, r, count, [...new Set(cells)].sort()]);
          }
        }
      }
    }
  });

  test("an open bar trigger opens its decor's lineage at depth 0, whatever its row, over the ground of its row", () => {
    for (const name of VARIATION_NAMES) {
      for (const shade of SHADE_NAMES) {
        const decor: Decor = { variation: VARIATIONS[name], shade: SHADES[shade] };
        for (const address of [[row(0, 2), cell(2, 4)], [row(1, 2), cell(0, 4)]]) {
          const region = { kind: "bar", decor, address } as const;
          const { disclosure } = decorationFor(DRACULA, region, ColorDepth.TRUECOLOR);
          expect([name, shade, disclosure]).toEqual([name, shade, { decor, depth: 0, ground: rowGround(decor, address) }]);
          expect(hueOf(disclosure)).toBe(VARIATIONS[name].open[0]);
        }
      }
    }
  });

});

describe("distributions", () => {
  test("van der Corput is bit reversal and reads no count", () => {
    const vdc = DISTRIBUTIONS["van-der-corput"];
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => vdc(i, 8))).toEqual([
      0, 0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875,
    ]);
  });

  test("n-free distributions ignore the count; n-reading ones use it", () => {
    for (let index = 0; index < 8; index++) {
      for (const name of N_FREE) {
        expect(DISTRIBUTIONS[name](index, 8)).toBe(DISTRIBUTIONS[name](index, 20));
      }
    }
    for (const name of N_READING) {
      expect(DISTRIBUTIONS[name](1, 8)).not.toBe(DISTRIBUTIONS[name](1, 20));
    }
  });

  test("every distribution lands in [0, 1) for every legal (index, count)", () => {
    for (const name of ALL_NAMES) {
      for (let count = 1; count <= 12; count++) {
        for (let index = 0; index < count; index++) {
          const v = DISTRIBUTIONS[name](index, count);
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
        expect([name, seed, decorFor(DRACULA, TWO_STEP, lone.address).hex]).toEqual([
          name,
          seed,
          inOrder.get(pathKey(lone.path)),
        ]);
        // The whole tree, evaluated back to front — a walk cursor would diverge here.
        for (const { path, address } of [...nodes].reverse()) {
          expect(decorFor(DRACULA, TWO_STEP, address).hex).toBe(inOrder.get(pathKey(path)));
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
    for (const name of N_READING) {
      const distribution = DISTRIBUTIONS[name];
      let moved = 0;
      for (const { seed, shape } of SHAPES) {
        const rng = seededRng(seed);
        const parents = allNodes(shape, distribution).filter(({ path }) => nodeAt(shape, path).children.length >= 2);
        if (parents.length === 0) continue;
        const target = drawFrom(rng, parents).path;
        const before = colourMap(shape, distribution);
        const after = colourMap(withSiblingAdded(shape, target), distribution);
        for (const [key, hex] of before) if (after.get(key) !== hex) moved++;
      }
      expect(moved).toBeGreaterThan(0);
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
      for (const quantize of [inBin, nearestPoint]) {
        expect(vocabularySelect([only], step, quantize)).toBe(only);
      }
    }
  });

  test("an empty vocabulary has nothing to select and says so", () => {
    expect(() => vocabularySelect([], undefined, nearestPoint)).toThrow(/empty vocabulary/);
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
  test("an item wears one of its band's items — the band's hue at a tone of the dial's window — picked by the step that places it along its row under the window's own rule", () => {
    const at = (index: number, count: number): PlacedStep => ({ index, count, distribution: VDC });
    for (const shade of SHADE_NAMES) {
      const decor: Decor = { variation: VARIATIONS["ends-primary"], shade: SHADES[shade] };
      const disclosure: Disclosure = { decor, depth: 0, ground: FIRST_ROW };
      const { tones, quantize } = SHADES[shade];
      for (const palette of REGISTRY) {
        const { items } = bandFor(palette, disclosure, ColorDepth.TRUECOLOR);
        // The items are the lineage's hue at each tone, as the palette names it.
        expect(items.map((c) => c.hex)).toEqual(tones.map((tone) => paletteRole(palette, shadeRole("primary", tone)).hex));
        const item = (place: PlacedStep | undefined) =>
          bandItemFor(palette, disclosure, place, ColorDepth.TRUECOLOR).hex;
        const inBand = (address: Address) =>
          decorationFor(palette, { kind: "band", band: disclosure, address }, ColorDepth.TRUECOLOR).tint.hex;
        // A cell picks its item as a bar cell picks its shade: the window's
        // own rule over its placement, so neighbours never share one.
        const expected = (index: number): string => items[QUANTIZE[quantize](VDC(index, 1), tones.length)]!.hex;
        for (const count of [2, 5, 12]) {
          const cells = Array.from({ length: count }, (_, index) => item(at(index, count)));
          expect(cells).toEqual(cells.map((_, index) => expected(index)));
        }
        // A cell of a row inside a body is picked by its cell, not its row:
        // rows 0 and 1 of a body deal their cells alike.
        for (const r of [0, 1]) {
          expect([0, 1, 2].map((c) => inBand([row(r, 2), cell(c, 3)]))).toEqual([0, 1, 2].map(expected));
        }
        // Whatever is nested inside a cell wears that cell's item: edit chrome
        // wraps every content cell of a user's body in a unit (✚, label, the
        // cell, ✚), so the cell is the unit's second child whichever cell it is.
        expect([0, 1, 2].map((c) => inBand([cell(c, 3), cell(1, 4)]))).toEqual([0, 1, 2].map(expected));
        // A row picks nothing: a segment that is a row by itself is a first
        // cell, as edit chrome's one-cell row around it is.
        expect([0, 1].map((r) => inBand([row(r, 2)]))).toEqual([expected(0), expected(0)]);
        expect([0, 1].map((r) => inBand([row(r, 2), cell(0, 1), cell(1, 4)]))).toEqual([expected(0), expected(0)]);
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
      const disclosure: Disclosure = { decor, depth: 0, ground: FIRST_ROW };
      for (const palette of REGISTRY) {
        const { tint, text } = decorationFor(palette, { kind: "band", band: disclosure, address: [] }, ColorDepth.TRUECOLOR);
        expect([palette.name, shade, text.hex]).toEqual([palette.name, shade, SHADES[shade].text(palette, "primary", tint, ColorDepth.TRUECOLOR).hex]);
      }
    }
  });
});

describe("a band item is drawn, never thrown — the settings controls are band items", () => {
  test("a band whose plane stands on its trigger reports it, and its items are drawn at every depth", () => {
    // A palette a style washed out: the accent, the background and the
    // foreground all but meet, the accent stands off its dark row as it is,
    // and no plane recedes from it.
    const washed = new Palette(
      "washed",
      true,
      new Map<string, ColorRgba>([
        ...getThemePalette("nord")!.vars,
        ["accent", new ColorRgba(0xff, 0xff, 0xff)],
        ["background", new ColorRgba(0xff, 0xff, 0xff)],
        ["foreground", new ColorRgba(0xf4, 0xf4, 0xf4)],
        ["secondary-darken-1", new ColorRgba(0x20, 0x20, 0x20)],
      ]),
    );
    const disclosure: Disclosure = { decor: TODAY, depth: 0, ground: [{ hue: "secondary", shade: "darken-1" }] };
    for (const drawnAt of DRAWN) {
      // Every floor the band stands short of, each in the module's words (which
      // pairs a band must report is held by the seam test above).
      const { shortfalls } = bandFor(washed, disclosure, drawnAt);
      expect(shortfalls.length).toBeGreaterThan(0);
      const at = `as drawn at depth ${ColorDepth[drawnAt]}`;
      for (const line of shortfalls) {
        expect(line).toMatch(
          new RegExp(
            `^theme "washed": (no open-trigger colour stands 2\\.2:1 off every cell beside it — the nearest stands \\d\\.\\d{2}:1 ${at}; another shade or variation clears it|an open band's plane stands ΔE 0\\.\\d{3} off the trigger that opened it ${at}, under the 0\\.1 that tells them apart; another style clears it|an open band's (trigger|plane|item \\d) and item \\d stand ΔE 0\\.\\d{3} apart ${at}, under the 0\\.04 below which two cells in those colours are joined by a divider and read as one)$`,
          ),
        );
      }
      for (let index = 0; index < 6; index++) {
        expect(() => bandItemFor(washed, disclosure, { index, count: 6, distribution: VDC }, drawnAt)).not.toThrow();
      }
    }
  });
});

describe("no floor is measured where nothing is drawn in colour", () => {
  test("a band that stands short in truecolor reports nothing at colour depth none (DEFAULT)", () => {
    // textual-dark's first row under `alt`, turning from its navy to its
    // orange: no colour stands 2.2:1 off both.
    const textualDark = getThemePalette("textual-dark")!;
    const decor: Decor = { variation: VARIATIONS.alt, shade: SHADES[floorOf("shade")] };
    const ground = rowGround(decor, [row(0, 2), cell(0, 5)]);
    const disclosure: Disclosure = { decor, depth: 0, ground };
    expect(bandFor(textualDark, disclosure, ColorDepth.TRUECOLOR).shortfalls).not.toEqual([]);
    expect(bandFor(textualDark, disclosure, ColorDepth.DEFAULT).shortfalls).toEqual([]);
  });
});

describe("a band's drawn plane always has a colour that keeps its floors", () => {
  // bandFor throws if nothing a depth draws keeps its plane's floors. The
  // tables rule that out whatever the palette: the floors are measured on
  // drawn colours, each an entry of the depth's table, and wherever the
  // trigger, the nested trigger and the enclosing plane are drawn, the entries
  // standing STATE_FLOOR off the nested trigger outnumber those either ΔE
  // floor can rule out.
  const LEVELS = [0, 95, 135, 175, 215, 255];
  const XTERM = [
    ...LEVELS.flatMap((r) => LEVELS.flatMap((g) => LEVELS.map((b) => new ColorRgba(r, g, b)))),
    ...Array.from({ length: 24 }, (_, i) => new ColorRgba(8 + 10 * i, 8 + 10 * i, 8 + 10 * i)),
  ];
  test.each([
    ["ansi", ColorDepth.STANDARD, 16],
    ["256 colours", ColorDepth.EIGHT_BIT, 240],
  ] as const)("at %s, over its %i entries", (_name, drawnAt, entries) => {
    // Every colour the depth draws, through its own rounding.
    const table = [...new Map(XTERM.map((c) => drawnColour(c, drawnAt)).map((c) => [c.hex, c])).values()];
    expect(table.length).toBe(entries);
    const mostNear = (floor: number): number =>
      Math.max(...table.map((at) => table.filter((v) => deltaE(v, at) < floor).length));
    const fewestOffNested = Math.min(
      ...table.map((nested) => table.filter((v) => contrastRatio(v, nested) >= STATE_FLOOR).length),
    );
    expect(fewestOffNested).toBeGreaterThan(mostNear(BAND_FLOORS.triggerPlane) + mostNear(BAND_FLOORS.nestedPlane));
  });
});
