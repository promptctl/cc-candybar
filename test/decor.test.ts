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
  blendRgb,
  ColorRgba,
  contrastFor,
  contrastRatio,
  ensureContrast,
  getThemePalette,
  listThemePalettes,
  Oklch,
  Palette,
  relativeLuminance,
  SEAM_MIN_DELTA_E,
  transposePalette,
} from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { floorOf } from "../src/config/globals-fields";
import {
  BAND_FLOORS,
  BAND_RECESSION,
  VARIATIONS,
  SHADES,
  DECOR_HUES,
  OPEN_HUE,
  DEFAULT_DISTRIBUTION,
  DISTRIBUTION_NAMES,
  DISTRIBUTIONS,
  STATE_FLOOR,
  bandFor,
  bandItemFor,
  decorEntryColour,
  decorEntryFor,
  decorFor,
  decorationFor,
  hueAtDepth,
  paletteRole,
  rowGround,
  shadeRole,
  stateFor,
  textOn,
  TEXT_MIN_CONTRAST,
  vocabularyOf,
  vocabularySelect,
  inBin,
  nearestPoint,
  type Address,
  type AddressStep,
  type Decor,
  type DecorEntry,
  type DecorHue,
  type Disclosure,
  type Distribution,
  type DistributionName,
  type Ground,
  type PlacedStep,
  type RoleShade,
  type ShadeName,
  type Variation,
  type VariationName,
  WHOLE_ROW,
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

const DRACULA = getThemePalette("dracula");
// The decor the address properties are stated under: a two-step variation, so
// a row alternation is visible, at the default shade. Every property below is
// about placement, which no variation or shade changes; the per-variation and
// per-shade facts have their own describes.
const TWO_STEP: Decor = { variation: VARIATIONS["duo"], shade: SHADES[floorOf("shade")] };
const decorWith = (variation: Variation): Decor => ({ ...TWO_STEP, variation });
const VARIATION_NAMES = Object.keys(VARIATIONS) as VariationName[];
const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
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

const VDC = DISTRIBUTIONS["van-der-corput"];
const row = (index: number, count: number): AddressStep => ({ index, count, distribution: VDC, axis: "row" });
const cell = (index: number, count: number): AddressStep => ({ index, count, distribution: VDC, axis: "cell" });

// A cell as the SGR writer draws it: a translucent colour composited over
// black, the writer's substrate. Text is chosen against this, so it is what a
// floor is measured on.
const drawnGround = (c: ColorRgba): ColorRgba => c.compositeOver(new ColorRgba(0, 0, 0));

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
  test("runs muted, then a window of three rungs from the deepest to the brightest, each one rung above the last", () => {
    expect(SHADE_NAMES).toEqual(["muted", "deepest", "deeper", "middle", "brighter", "brightest"]);
    expect(SHADES.muted.tones).toEqual(["muted"]);
    const windows = SHADE_NAMES.slice(1).map((name) => SHADES[name].tones);
    for (const [p, tones] of windows.entries()) {
      // The window is three neighbouring rungs, from rung p.
      expect([...tones].map(rung).sort()).toEqual([p, p + 1, p + 2]);
    }
    // Turning the dial one position moves every cell exactly one rung.
    for (let p = 1; p < windows.length; p++) {
      expect(windows[p]!.map(rung)).toEqual(windows[p - 1]!.map((s) => rung(s) + 1));
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

  test("every variation steps only through decorative hues, and the default reaches the open hue", () => {
    for (const { hues } of Object.values(VARIATIONS)) {
      expect(hues.length).toBeGreaterThan(0);
      for (const hue of hues) expect(DECOR_HUES).toContain(hue);
    }
    // The bundled default (brandon-theme-picker-bgw.7g6) wears the accent on
    // its second row, so an open trigger can stand among accent cells.
    expect(VARIATIONS["accent"].hues).toContain(OPEN_HUE);
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
    for (const shade of SHADE_NAMES.slice(1)) {
      const { tones } = SHADES[shade];
      const shades = [0, 1, 2, 3, 4, 5, 6, 7].map(
        (i) => decorEntryFor({ ...TWO_STEP, shade: SHADES[shade] }, [row(0, 2), cell(i, 8)]).shade,
      );
      const low = rung(tones[0]!);
      expect([shade, shades.map((s) => rung(s) - low)]).toEqual([shade, [0, 1, 2, 1, 0, 1, 2, 0]]);
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
      const hues = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => decorEntryFor(decor, [row(i, 8), cell(0, 3)]).hue);
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

  test("the root selects the variation's first step at the shade's first entry", () => {
    // The empty address has no step to place, so no distribution can reach it.
    for (const name of VARIATION_NAMES) {
      for (const shade of SHADE_NAMES) {
        const decor: Decor = { variation: VARIATIONS[name], shade: SHADES[shade] };
        expect(decorEntryFor(decor, [])).toEqual({ hue: VARIATIONS[name].hues[0], shade: SHADES[shade].tones[0] });
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

  test("an open bar trigger opens the accent, whatever its row and the decor, over the ground of its row", () => {
    for (const name of VARIATION_NAMES) {
      for (const shade of SHADE_NAMES) {
        const decor: Decor = { variation: VARIATIONS[name], shade: SHADES[shade] };
        for (const address of [[row(0, 2), cell(2, 4)], [row(1, 2), cell(0, 4)]]) {
          const region = { kind: "bar", decor, address } as const;
          expect([name, shade, decorationFor(DRACULA, region, ColorDepth.TRUECOLOR).disclosure]).toEqual([
            name,
            shade,
            { hue: OPEN_HUE, depth: 0, ground: rowGround(decor, address) },
          ]);
        }
      }
    }
  });

  test("a decorated cell's text is the pole on its shades, and on a muted row its role's own text colour wherever that reads, moved to the floor where it does not, on every theme as drawn", () => {
    const wrong: string[] = [];
    let kept = 0;
    let moved = 0;
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      for (const palette of REGISTRY) {
        for (const shade of SHADE_NAMES) {
          // The variations' rows between them reach every decorative hue.
          for (const variation of VARIATION_NAMES) {
            const decor: Decor = { variation: VARIATIONS[variation], shade: SHADES[shade] };
            for (const address of [[row(0, 2), cell(1, 4)], [row(1, 2), cell(2, 4)]]) {
              const { hue } = decorEntryFor(decor, address);
              const { tint, text } = decorationFor(palette, { kind: "bar", decor, address }, drawnAt);
              const where = `${palette.name} ${variation}/${shade} ${hue} at ${ColorDepth[drawnAt]}`;
              const ratio = contrastRatio(shown(tint), shown(text));
              if (ratio < TEXT_MIN_CONTRAST) wrong.push(`${where}: ${ratio.toFixed(2)}`);
              if (shade !== "muted") {
                if (text.hex !== textOn(palette, tint, drawnAt).hex) wrong.push(`${where}: not the pole`);
                continue;
              }
              // Its role's own text, slid by rich-js until it reads — the hue
              // kept, the lightness moved — and untouched where it already does.
              const own = paletteRole(palette, `text-${hue}`);
              const slid = ensureContrast(own, tint, TEXT_MIN_CONTRAST, drawnAt);
              if (text.hex !== slid.hex) wrong.push(`${where}: ${text.hex}, not its own ${own.hex} slid to the floor (${slid.hex})`);
              else if (slid.hex === own.hex) kept++;
              else moved++;
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    // Non-vacuous both ways: the registry has muted roles whose own text
    // reads, and roles whose own text only the floor makes read — in
    // truecolor every bundled theme's does, so those are the depths that round.
    expect(kept).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(0);
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
    for (const name of ALL_NAMES) {
      for (const { shape } of SHAPES) {
        for (const { address } of allNodes(shape, DISTRIBUTIONS[name])) {
          for (const step of [undefined, ...address]) {
            for (const quantize of [inBin, nearestPoint]) {
              expect(vocabularySelect([only], step, quantize)).toBe(only);
            }
          }
        }
      }
    }
  });

  test("an empty vocabulary has nothing to select and says so", () => {
    expect(() => vocabularySelect([], undefined, nearestPoint)).toThrow(/empty vocabulary/);
  });
});

// --- candybar-render-ai7.2, candybar-theme-colours-6fq5.e5n: the state floor ---
// [LAW:verifiable-goals] Each `describe` is one line of the Done-when, over the
// WHOLE registry, every bundled style, every position of the dial and every
// ground a shipped variation deals under every distribution — the failures the floor exists for are
// theme-specific (textual-dark's navy secondary, textual-ansi's flat shades),
// so a sample proves nothing.

const REGISTRY = listThemePalettes().map((name) => getThemePalette(name));
const STYLED = REGISTRY.flatMap((base) =>
  Object.entries(DEFAULT_DSL_CONFIG.styles).map(([style, key]) => ({
    name: `${base.name}/${style}`,
    style,
    palette: transposePalette(base, key),
  })),
);
const STYLE_NAMES = Object.keys(DEFAULT_DSL_CONFIG.styles);
const DRAWN = [ColorDepth.TRUECOLOR, ColorDepth.EIGHT_BIT, ColorDepth.STANDARD] as const;
const shownAt =
  (drawnAt: ColorDepth) =>
  (c: ColorRgba): ColorRgba =>
    drawnColour(c, drawnAt);

// Rows this long deal every ground a row can (pinned below): a cell's place
// in its row picks its shade, so the distribution its container authors
// decides which shades a row of a given length wears.
const ROW_REACH = 12;
/** The ground of a row of `length` cells, starting on `start`, placed by `placedBy`. */
const groundOf = (
  variation: VariationName,
  shade: ShadeName,
  start: number,
  length: number,
  placedBy: DistributionName,
): Ground =>
  rowGround({ variation: VARIATIONS[variation], shade: SHADES[shade] }, [
    row(start, 2),
    { index: 0, count: length, distribution: DISTRIBUTIONS[placedBy], axis: "cell" },
  ]);
const groundName = (ground: Ground): string => ground.map((e) => shadeRole(e.hue, e.shade)).join("+");
/**
 * Every ground an open bar trigger can stand on: what a row of every length,
 * at either start, placed by every distribution, wears under every shipped
 * variation at every position of the dial — derived from the tables, so a new
 * one is measured the moment it ships. Named by its entries, which is also
 * what makes two rows' grounds one.
 */
const GROUNDS: readonly { readonly name: string; readonly ground: Ground }[] = [
  ...new Map(
    DISTRIBUTION_NAMES.flatMap((placedBy) =>
      VARIATION_NAMES.flatMap((variation) =>
        SHADE_NAMES.flatMap((shade) =>
          [0, 1].flatMap((r) =>
            Array.from({ length: ROW_REACH }, (_, n) => {
              const ground = groundOf(variation, shade, r, n + 1, placedBy);
              const name = groundName(ground);
              return [name, { name, ground }] as const;
            }),
          ),
        ),
      ),
    ),
  ).values(),
];

test("no row longer than ROW_REACH, under any distribution, deals a ground GROUNDS lacks", () => {
  // Far past the cells a terminal row holds.
  const LONGEST = 8 * ROW_REACH;
  const named = new Set(GROUNDS.map(({ name }) => name));
  const fresh: string[] = [];
  for (const placedBy of DISTRIBUTION_NAMES) {
    for (const variation of VARIATION_NAMES) {
      for (const shade of SHADE_NAMES) {
        for (const r of [0, 1]) {
          for (let length = ROW_REACH + 1; length <= LONGEST; length++) {
            const name = groundName(groundOf(variation, shade, r, length, placedBy));
            if (!named.has(name)) fresh.push(`${placedBy} ${variation}/${shade} row ${r}, ${length} cells: ${name}`);
          }
        }
      }
    }
  }
  expect(fresh).toEqual([]);
});
const DEPTH_HUES = [0, 1, 2, 3].map((depth) => hueAtDepth(OPEN_HUE, depth));

/** The closed cells a trigger on `ground` stands among. */
const groundCells = (palette: Palette, ground: Ground): ColorRgba[] =>
  ground.map((entry) => decorEntryColour(palette, entry));

/**
 * Whether ANY colour stands STATE_FLOOR off every one of `cells`, as drawn. A
 * contrast ratio reads luminance alone, so the question is whether some
 * luminance in [0, 1] lies outside every cell's band of luminances too close
 * to it — answered here in the test's own words, independent of any search.
 */
function someColourClears(cells: readonly ColorRgba[]): boolean {
  const bands = cells
    .map((c) => relativeLuminance(drawnGround(c)))
    .map((l) => [(l + 0.05) / STATE_FLOOR - 0.05, STATE_FLOOR * (l + 0.05) - 0.05] as const)
    .sort((x, y) => x[0] - y[0]);
  let free = 0;
  for (const [lo, hi] of bands) {
    if (lo >= free) return true;
    free = Math.max(free, hi);
  }
  return free <= 1;
}

/**
 * How far the colour standing furthest off its nearest cell stands, as drawn.
 * A contrast ratio reads luminance alone, so that colour is black, white, or
 * the balance of the two cells adjacent in luminance that stand furthest
 * apart, which stands the root of their ratio off each — answered here in the
 * test's own words, independent of any search.
 */
function furthestAnyColourStands(cells: readonly ColorRgba[]): number {
  const rising = cells.map((c) => relativeLuminance(drawnGround(c)) + 0.05).sort((x, y) => x - y);
  return Math.max(
    rising[0]! / 0.05,
    1.05 / rising[rising.length - 1]!,
    ...rising.slice(1).map((l, i) => Math.sqrt(l / rising[i]!)),
  );
}

describe("done-when: an open trigger stands STATE_FLOOR off every closed cell of the row it stands in", () => {
  // One test per depth and style: together they walk every theme × ground ×
  // depth hue, past what one test's timeout allows.
  test.each(DRAWN.flatMap((drawnAt) => STYLE_NAMES.map((style) => [drawnAt, style] as const)))(
    "a shortfall is reported exactly where the state stands short of a cell as the terminal draws both, and by that much (depth %s, style %s)",
    (drawnAt, style) => {
      const shown = shownAt(drawnAt);
      const wrong: string[] = [];
      for (const { name, palette } of STYLED.filter((styled) => styled.style === style)) {
        for (const { name: where, ground } of GROUNDS) {
          const cells = groundCells(palette, ground).map((c) => shown(drawnGround(c)));
          for (const hue of DEPTH_HUES) {
            const { state, short } = stateFor(palette, hue, groundCells(palette, ground), drawnAt);
            const stands = Math.min(...cells.map((c) => contrastRatio(shown(state), c)));
            const said = short === null ? "clears" : short.toFixed(6);
            const drawn = stands >= STATE_FLOOR ? "clears" : stands.toFixed(6);
            if (said !== drawn) wrong.push(`${name} ${where} ${hue}: said ${said}, drawn ${drawn}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  // Black and white end every ray the search walks. In truecolor the ray
  // toward black can stop a hair off it (#000002); a depth that draws from a
  // table rounds both ends onto its own black and white.
  test.each(
    [ColorDepth.EIGHT_BIT, ColorDepth.STANDARD].flatMap((drawnAt) =>
      STYLE_NAMES.map((style) => [drawnAt, style] as const),
    ),
  )(
    "a state that stands short as drawn stands at least as far off its nearest cell as black or white would (depth %s, style %s)",
    (drawnAt, style) => {
      const shown = shownAt(drawnAt);
      const ends = [new ColorRgba(0, 0, 0), new ColorRgba(255, 255, 255)];
      const wrong: string[] = [];
      for (const { name, palette } of STYLED.filter((styled) => styled.style === style)) {
        for (const { name: where, ground } of GROUNDS) {
          const cells = groundCells(palette, ground).map((c) => shown(drawnGround(c)));
          const stands = (c: ColorRgba): number => Math.min(...cells.map((x) => contrastRatio(shown(c), x)));
          const furthestEnd = Math.max(...ends.map(stands));
          for (const hue of DEPTH_HUES) {
            const { state, short } = stateFor(palette, hue, groundCells(palette, ground), drawnAt);
            if (short !== null && stands(state) < furthestEnd) {
              wrong.push(`${name} ${where} ${hue}: ${stands(state).toFixed(3)}:1, an end ${furthestEnd.toFixed(3)}:1`);
            }
          }
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  test("the search falls short only where no colour at all stands off the row — it never gives up while one does", () => {
    const wrong: string[] = [];
    const short: Ground[] = [];
    for (const { name, palette } of STYLED) {
      for (const { name: where, ground } of GROUNDS) {
        const possible = someColourClears(groundCells(palette, ground));
        for (const hue of DEPTH_HUES) {
          const search = stateFor(palette, hue, groundCells(palette, ground), ColorDepth.TRUECOLOR);
          if ((search.short === null) !== possible) wrong.push(`${name} ${where} ${hue} possible=${possible}`);
          if (search.short !== null) short.push(ground);
        }
      }
    }
    expect(wrong).toEqual([]);
    // What cannot clear is a row turning between two roles at opposite ends of
    // the lightness axis (textual-dark's navy and orange under `alt`): a single
    // role's row always leaves a colour. Non-vacuous: the registry has such rows.
    expect(short.length).toBeGreaterThan(0);
    expect(short.every((ground) => new Set(ground.map((e) => e.hue)).size > 1)).toBe(true);
  });

  test("a row no colour stands off draws the colour standing furthest off its nearest cell as the terminal draws both, and says how far that is", () => {
    // A row of black, grey and white: every colour sits within 2.2:1 of one.
    const roles = new Map<string, ColorRgba>([
      ["accent", new ColorRgba(0xfe, 0xa6, 0x2b)],
      ["secondary-darken-1", new ColorRgba(0, 0, 0)],
      ["secondary", new ColorRgba(0x77, 0x77, 0x77)],
      ["secondary-lighten-1", new ColorRgba(0xff, 0xff, 0xff)],
    ]);
    const straddling = new Palette("straddling", true, roles);
    const ground: Ground = SHADES.middle.tones.map((shade) => ({ hue: "secondary", shade }));
    const cells = groundCells(straddling, ground);
    expect(someColourClears(cells)).toBe(false);
    for (const drawnAt of [ColorDepth.TRUECOLOR, ColorDepth.EIGHT_BIT]) {
      const shown = shownAt(drawnAt);
      const stands = (c: ColorRgba): number => Math.min(...cells.map((x) => contrastRatio(shown(c), shown(x))));
      const { state, short } = stateFor(straddling, "accent", cells, drawnAt);
      expect(short).toBe(stands(state));
      expect(short!).toBeLessThan(STATE_FLOOR);
      // At 256 colours the deep orange truecolor picks rounds nearer the black
      // than the hue itself stands off the white.
      expect(stands(state)).toBeGreaterThanOrEqual(stands(paletteRole(straddling, "accent")) - 1e-9);
    }
    // In truecolor, as far as any colour stands — at the balance of the black
    // and the grey — short of it only by the 8-bit step the hue's ray is
    // drawn in.
    const { state } = stateFor(straddling, "accent", cells, ColorDepth.TRUECOLOR);
    const nearest = (c: ColorRgba): number => Math.min(...cells.map((x) => contrastRatio(c, x)));
    expect(nearest(state)).toBeGreaterThan(furthestAnyColourStands(cells) * 0.99);
  });

  test("the search reaches the end of the lightness axis when only that end clears", () => {
    // A dark cell (luminance .063) leaves only colours within a hair of black
    // below it, and a light one (.46) rules out every colour from there to
    // white: only the far dark end stands off both.
    const roles = new Map<string, ColorRgba>([
      ["accent", new ColorRgba(0xd0, 0x70, 0x30)],
      ["secondary", new ColorRgba(0x47, 0x47, 0x47)],
      ["secondary-lighten-1", new ColorRgba(0xb5, 0xb5, 0xb5)],
    ]);
    const ends = new Palette("ends", true, roles);
    const ground: Ground = [
      { hue: "secondary", shade: "base" },
      { hue: "secondary", shade: "lighten-1" },
    ];
    const { state, short } = stateFor(ends, "accent", groundCells(ends, ground), ColorDepth.TRUECOLOR);
    expect(short).toBeNull();
    expect(relativeLuminance(state)).toBeLessThan(0.002);
  });

  test("another shade or variation clears every shortfall, as its message says: under `muted` a whole-row variation wears one colour per row", () => {
    // The witness the message leans on: at the dial's muted position a
    // variation that keeps its role across the row draws each row in one
    // colour, and black or white stands at least √21:1 off any one colour —
    // the two ends of the search, drawn at every depth.
    const wrong: string[] = [];
    for (const variation of VARIATION_NAMES.filter((name) => VARIATIONS[name].run === WHOLE_ROW)) {
      const decor: Decor = { variation: VARIATIONS[variation], shade: SHADES.muted };
      for (const r of [0, 1]) {
        const ground = rowGround(decor, [row(r, 2), cell(0, ROW_REACH)]);
        expect([variation, r, ground.length]).toEqual([variation, r, 1]);
        for (const { name, palette } of STYLED) {
          for (const drawnAt of DRAWN) {
            if (stateFor(palette, OPEN_HUE, groundCells(palette, ground), drawnAt).short !== null) {
              wrong.push(`${name} ${variation} row ${r} at ${ColorDepth[drawnAt]}`);
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("done-when: the enforcement is a floor, not a transform", () => {
  test("a hue that already stands off its row is drawn as the palette names it, byte for byte", () => {
    let untouched = 0;
    for (const palette of REGISTRY) {
      for (const { ground } of GROUNDS) {
        const cells = groundCells(palette, ground).map(drawnGround);
        for (const hue of DEPTH_HUES) {
          const pure = drawnGround(paletteRole(palette, hue));
          if (!cells.every((c) => contrastRatio(pure, c) >= STATE_FLOOR)) continue;
          untouched++;
          expect([palette.name, hue, stateFor(palette, hue, groundCells(palette, ground), ColorDepth.TRUECOLOR).state.hex]).toEqual([
            palette.name,
            hue,
            pure.hex,
          ]);
        }
      }
    }
    // At least one must, or the "floor not transform" clause is vacuous.
    expect(untouched).toBeGreaterThan(0);
  });
});

describe("done-when: text on a state cell is contrast-chosen and clears the text floor on every pair", () => {
  test("is the theme pole on the side contrastFor names, slid that way only when it misses the floor", () => {
    for (const palette of REGISTRY) {
      const poles = [paletteRole(palette, "background"), paletteRole(palette, "foreground")];
      for (const { ground } of GROUNDS) {
        for (const hue of DEPTH_HUES) {
          const { state } = stateFor(palette, hue, groundCells(palette, ground), ColorDepth.TRUECOLOR);
          const text = textOn(palette, state, ColorDepth.TRUECOLOR);
          const side = contrastFor(state);
          const bestPole = poles.reduce((a, b) =>
            contrastRatio(side, b) < contrastRatio(side, a) ? b : a,
          );
          // The text lies on the side the max-contrast pick names — a light cell
          // gets darker text, a dark cell lighter — so a slide never carries it
          // through the background into the other polarity.
          const lighter = relativeLuminance(text) > relativeLuminance(drawnGround(state));
          expect([palette.name, hue, lighter]).toEqual([palette.name, hue, side.hex === "#ffffff"]);
          // A pole that already clears is returned untouched — the floor never
          // transforms text that was already legible.
          if (contrastRatio(drawnGround(state), bestPole) >= TEXT_MIN_CONTRAST) {
            expect([palette.name, hue, text.hex]).toEqual([palette.name, hue, bestPole.hex]);
          }
          expect([palette.name, hue, contrastRatio(drawnGround(state), text) >= TEXT_MIN_CONTRAST]).toEqual([
            palette.name,
            hue,
            true,
          ]);
        }
      }
    }
  });

  // A slide keeps its colour's OKLCH chroma and hue and moves only lightness, so
  // text carries the lineage of the pole it was slid from. On a mid-luminance
  // cell the pole that merely measures better can sit on the far side of the
  // background; sliding IT would wear that pole's hue at the other polarity.
  // The text must descend from the pole on the side the max-contrast pick
  // names — the theme's own dark or light, only deepened.
  test("descends from the side's own pole: same chroma and hue, on every shade and band colour", () => {
    const hueGap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
    for (const palette of REGISTRY) {
      const poles = [paletteRole(palette, "background"), paletteRole(palette, "foreground")];
      const cells = [
        ...SHADE_NAMES.flatMap((shade) =>
          vocabularyOf({ variation: VARIATIONS.duo, shade: SHADES[shade] })
            .concat(vocabularyOf({ variation: VARIATIONS.accent, shade: SHADES[shade] }))
            .map((entry) => decorEntryColour(palette, entry)),
        ),
        ...GROUNDS.flatMap(({ ground }) =>
          [0, 1, 2, 3].flatMap((depth) => {
            const band = bandFor(palette, { hue: OPEN_HUE, depth, ground }, ColorDepth.TRUECOLOR);
            return [band.state, band.plane];
          }),
        ),
      ];
      for (const cell of cells) {
        const side = contrastFor(cell);
        const pole = Oklch.fromRgba(
          poles.reduce((a, b) => (contrastRatio(side, b) < contrastRatio(side, a) ? b : a)),
        );
        const text = Oklch.fromRgba(textOn(palette, cell, ColorDepth.TRUECOLOR));
        // Toward white or black the sRGB gamut narrows, so a slide can only
        // LOSE chroma (atom-one-dark's foreground keeps .003 of its .020 at the
        // top); hue is only a fact where both colours still carry some, and
        // where 8-bit channels can hold it — below lightness .15 the largest
        // channel is a few steps, and one step turns the hue past 6° (nord's
        // text on a #5e7a87 band slides to #02030b, its pole's chroma at 7.9°).
        const sameLineage =
          text.c <= pole.c + 0.005 &&
          (text.c < 0.02 || pole.c < 0.02 || text.l < 0.15 || hueGap(text.h, pole.h) < 6);
        expect([palette.name, cell.hex, sameLineage]).toEqual([palette.name, cell.hex, true]);
      }
    }
  });
});

// ─── candybar-render-ai7.3: disclosure depth — bands, nesting, trigger ────────
//
// [LAW:verifiable-goals] Each `describe` is one of the ticket's three rules or
// one line of its Done-when, pinned over EVERY shipped theme × hue × depth.
// "Distinguishable" is measured as ΔE in OKLab (Euclidean distance over the
// coordinates rich-js's `Oklch` exposes): luminance contrast cannot see two
// hues at one lightness, and a nested trigger differs from its parent by HUE.
// The floors are BAND_FLOORS: bandFor searches for a plane that holds them,
// and every lineage is measured against them here, so a regression that moves
// any theme under one fails, naming it.

const THEMES = REGISTRY;
const DEPTHS = [0, 1, 2, 3] as const;
// The ground the band facts below are stated on where one suffices: a trigger
// in the default bar's first row, at the default shade.
const FIRST_ROW: Ground = rowGround(
  { variation: VARIATIONS[floorOf("variation")], shade: SHADES[floorOf("shade")] },
  [row(0, 2), cell(0, 5)],
);

function deltaE(a: ColorRgba, b: ColorRgba): number {
  const lab = (c: ColorRgba): [number, number, number] => {
    const o = Oklch.fromRgba(c);
    const rad = (o.h * Math.PI) / 180;
    return [o.l, o.c * Math.cos(rad), o.c * Math.sin(rad)];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * Every lineage a bar can open, named so a failure says which: every bar
 * trigger opens OPEN_HUE (decorationFor), from a row on any ground, and each
 * band nested in it a depth further.
 */
const LINEAGES = THEMES.flatMap((palette) =>
  GROUNDS.map(({ name, ground }) => ({ palette, hue: OPEN_HUE as DecorHue, ground, name: `${palette.name}@${name}` })),
);

describe("depth advances the hue", () => {
  test("the next vocabulary hue per depth, wrapping", () => {
    expect(hueAtDepth("primary", 0)).toBe("primary");
    expect(hueAtDepth("primary", 1)).toBe("secondary");
    expect(hueAtDepth("secondary", 1)).toBe("accent");
    expect(hueAtDepth("accent", 1)).toBe("primary");
    expect(hueAtDepth("secondary", DECOR_HUES.length)).toBe("secondary");
  });

  test("a trigger wears the state of the band it opens — one expression at every depth", () => {
    // A bar trigger (depth 0) stands among its row's cells; a trigger inside a
    // band among what it is drawn beside there: that band's plane, and its
    // state, which the ✕ leading the trigger's row wears (b9w).
    for (const { palette, hue, ground } of LINEAGES) {
      let among: readonly ColorRgba[] = groundCells(palette, ground);
      for (const depth of [0, 1, 2, 3]) {
        const search = stateFor(palette, hueAtDepth(hue, depth), among, ColorDepth.TRUECOLOR);
        const band = bandFor(palette, { hue, depth, ground }, ColorDepth.TRUECOLOR);
        expect(band.state.hex).toBe(search.state.hex);
        among = [band.plane, search.anchor];
      }
    }
  });

  test("a trigger inside a band stands STATE_FLOOR off the plane it sits on, as drawn at every depth", () => {
    const wrong: string[] = [];
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      for (const { palette, hue, ground, name } of LINEAGES) {
        for (const depth of [1, 2, 3]) {
          const ratio = contrastRatio(
            shown(drawnGround(bandFor(palette, { hue, depth, ground }, drawnAt).state)),
            shown(drawnGround(bandFor(palette, { hue, depth: depth - 1, ground }, drawnAt).plane)),
          );
          if (ratio < STATE_FLOOR) wrong.push(`${name} depth ${depth} at ${ColorDepth[drawnAt]}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("a band is a plane", () => {
  // The plane a band builds from the colour its trigger was searched to: into
  // the background, as a band always has — unless that plane would stand too
  // near its trigger (a state the search carried to the background itself) or
  // the plane it hangs in: then into the foreground, then each as far as the
  // cap, then the twelfth of the way to either pole nearest the recession,
  // the background's before the foreground's.
  const recededPlane = (
    palette: Palette,
    state: ColorRgba,
    depth: number,
    outer: readonly ColorRgba[],
  ): { readonly plane: ColorRgba; readonly background: ColorRgba } => {
    const recession = Math.min(
      BAND_RECESSION.cap,
      BAND_RECESSION.base + BAND_RECESSION.perDepth * depth,
    );
    const toward = (pole: "background" | "foreground", amount: number): ColorRgba =>
      blendRgb(state, paletteRole(palette, pole), amount);
    const holds = (p: ColorRgba): boolean =>
      deltaE(drawnGround(state), drawnGround(p)) >= BAND_FLOORS.triggerPlane &&
      outer.every((o) => deltaE(drawnGround(o), drawnGround(p)) >= BAND_FLOORS.nestedPlane);
    const background = toward("background", recession);
    const plane =
      [
        background,
        toward("foreground", recession),
        toward("background", BAND_RECESSION.cap),
        toward("foreground", BAND_RECESSION.cap),
      ].find(holds) ??
      Array.from({ length: 12 }, (_, i) => (i + 1) / 12)
        .sort((a, b) => Math.abs(a - recession) - Math.abs(b - recession))
        .flatMap((amount) => [toward("background", amount), toward("foreground", amount)])
        .find(holds) ??
      background;
    return { plane, background };
  };

  test("the plane is the state receded toward background by the depth's recession, capped — or, where that breaks a band floor, toward foreground, then as far as the cap, then the nearest twelfth that holds", () => {
    let intoForeground = 0;
    for (const { palette, hue, ground } of LINEAGES) {
      for (const depth of [0, 1, 2, 3, 4]) {
        const { state, plane } = bandFor(palette, { hue, depth, ground }, ColorDepth.TRUECOLOR);
        const outer = depth === 0 ? [] : [bandFor(palette, { hue, depth: depth - 1, ground }, ColorDepth.TRUECOLOR).plane];
        const expected = recededPlane(palette, state, depth, outer);
        if (expected.plane.hex !== expected.background.hex) intoForeground++;
        expect(plane.hex).toBe(expected.plane.hex);
      }
    }
    // Non-vacuous: some band's background plane breaks a floor.
    expect(intoForeground).toBeGreaterThan(0);
    // The cap bites: depth 4 would be 0.98 uncapped, and 0.75 is the ceiling.
    expect(BAND_RECESSION.base + BAND_RECESSION.perDepth * 4).toBeGreaterThan(
      BAND_RECESSION.cap,
    );
  });

  test.each([ColorDepth.EIGHT_BIT, ColorDepth.STANDARD].map((d) => [ColorDepth[d], d] as const))("drawn at %s, the plane recedes from the colour its own trigger's search settled on, drawn once wherever that keeps the band's floors", (_name, drawnAt) => {
    // Where no twelfth clears, the search settles on the candidate standing
    // furthest as drawn, so a depth can settle on an anchor of its own — near
    // black at 256 colours where truecolor settles on white — and the band
    // recedes from the anchor its trigger is drawn from. A plane is replaced
    // only where its rounding breaks a floor, so where it keeps them the band
    // draws it as it is.
    const shown = shownAt(drawnAt);
    const wrong: string[] = [];
    let checked = 0;
    let ownAnchor = 0;
    for (const { palette, hue, ground, name } of LINEAGES) {
      let outer: readonly ColorRgba[] = [];
      // A trigger inside a band stands among that band's plane and its state
      // as the ✕ is drawn in it.
      let among: readonly ColorRgba[] = groundCells(palette, ground);
      for (const depth of DEPTHS) {
        const anchorAt = (at: ColorDepth): ColorRgba =>
          stateFor(palette, hueAtDepth(hue, depth), among, at).anchor;
        const { plane } = recededPlane(palette, anchorAt(drawnAt), depth, outer);
        const once = shown(plane);
        const band = (d: number) => bandFor(palette, { hue, depth: d, ground }, drawnAt);
        const keepsFloors =
          deltaE(once, shown(band(depth).state)) >= BAND_FLOORS.triggerPlane &&
          contrastRatio(once, shown(band(depth + 1).state)) >= STATE_FLOOR &&
          (depth === 0 || deltaE(once, shown(band(depth - 1).plane)) >= BAND_FLOORS.nestedPlane);
        if (keepsFloors) {
          checked++;
          if (anchorAt(drawnAt).hex !== anchorAt(ColorDepth.TRUECOLOR).hex) ownAnchor++;
          if (shown(band(depth).plane).hex !== once.hex) wrong.push(`${name} depth ${depth}`);
        }
        outer = [plane];
        among = [plane, stateFor(palette, hueAtDepth(hue, depth), among, drawnAt).state];
      }
    }
    expect(wrong).toEqual([]);
    // Non-vacuous: bands whose depth settles on its own anchor are among those checked.
    expect(ownAnchor).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(LINEAGES.length);
  });

  test("an item wears one of its band's two items, picked by the step that places it along its row", () => {
    const disclosure: Disclosure = { hue: "primary", depth: 0, ground: FIRST_ROW };
    const at = (index: number, count: number): PlacedStep => ({ index, count, distribution: VDC });
    const row = (index: number, count: number): AddressStep => ({ ...at(index, count), axis: "row" });
    const cell = (index: number, count: number): AddressStep => ({ ...at(index, count), axis: "cell" });
    for (const palette of THEMES) {
      const { items } = bandFor(palette, disclosure, ColorDepth.TRUECOLOR);
      const [low, high] = [items[0]!.hex, items[1]!.hex];
      const item = (place: PlacedStep | undefined) =>
        bandItemFor(palette, disclosure, place, ColorDepth.TRUECOLOR).hex;
      const inBand = (address: Address) =>
        decorationFor(palette, { kind: "band", band: disclosure, address }, ColorDepth.TRUECOLOR).tint.hex;
      // Consecutive cells of a row alternate, however long the row — the
      // seams a row draws are between neighbours.
      for (const count of [2, 5, 12]) {
        const cells = Array.from({ length: count }, (_, index) => item(at(index, count)));
        expect(cells).toEqual(cells.map((_, index) => items[index % 2]!.hex));
      }
      // A cell of a row inside a body is picked by its cell, not its row:
      // rows 0 and 1 of a body deal their cells alike.
      for (const r of [0, 1]) {
        expect([0, 1, 2].map((c) => inBand([row(r, 2), cell(c, 3)]))).toEqual([low, high, low]);
      }
      // Whatever is nested inside a cell wears that cell's item: edit chrome
      // wraps every content cell of a user's body in a unit (✚, label, the
      // cell, ✚), so the cell is the unit's second child whichever cell it is.
      expect([0, 1, 2].map((c) => inBand([cell(c, 3), cell(1, 4)]))).toEqual([low, high, low]);
      // A row picks nothing: a segment that is a row by itself is a first
      // cell, as edit chrome's one-cell row around it is.
      expect([0, 1].map((r) => inBand([row(r, 2)]))).toEqual([low, low]);
      expect([0, 1].map((r) => inBand([row(r, 2), cell(0, 1), cell(1, 4)]))).toEqual([low, low]);
      // A body that is one segment is the low item, beside its ✕.
      expect(inBand([])).toBe(low);
      expect(item(undefined)).toBe(low);
      // A picker's option is its index over the whole domain: the page it is
      // drawn on (the count it is placed among) never recolours it.
      expect(item(at(7, 8))).toBe(item(at(7, 40)));
    }
  });

  // Band text is chosen by the same textOn every cell uses, so it clears the
  // one text floor. (Before brandon-theme-picker-bgw.b2g floored the pick, the
  // registry minimum was solarized-dark/accent's depth-1 plane at 2.188.)
  const TEXT_FLOOR = TEXT_MIN_CONTRAST;

  test("text on every band cell is contrast-chosen and clears the band floor on every theme", () => {
    for (const { palette, hue, ground } of LINEAGES) {
      for (const depth of DEPTHS) {
        const disclosure: Disclosure = { hue, depth, ground };
        const { plane } = bandFor(palette, disclosure, ColorDepth.TRUECOLOR);
        const cells = [
          plane,
          ...[0, 1, 2, 3, 4, 5].map((index) =>
            bandItemFor(palette, disclosure, { index, count: 6, distribution: DISTRIBUTIONS[DEFAULT_DISTRIBUTION] }, ColorDepth.TRUECOLOR),
          ),
        ];
        for (const cell of cells) {
          const ratio = contrastRatio(drawnGround(cell), textOn(palette, cell, ColorDepth.TRUECOLOR));
          expect(`${palette.name}/${hue} depth ${depth} ${cell.hex}: ${ratio.toFixed(3)}`).toMatch(
            ratio >= TEXT_FLOOR ? /./ : /^$/,
          );
        }
      }
    }
  });

  test("at 256 colours the drawn text clears the band floor on the drawn cell", () => {
    // The band as 256 draws it — repaired where rounding broke a floor — and
    // both halves rounded to the xterm cube independently; the pair the
    // terminal draws is what must clear the floor.
    const drawn = (c: ColorRgba) => drawnColour(c, ColorDepth.EIGHT_BIT);
    for (const { palette, hue, ground } of LINEAGES) {
      for (const depth of DEPTHS) {
        const disclosure: Disclosure = { hue, depth, ground };
        const { plane, state } = bandFor(palette, disclosure, ColorDepth.EIGHT_BIT);
        for (const cell of [plane, state]) {
          const text = textOn(palette, cell, ColorDepth.EIGHT_BIT);
          const ratio = contrastRatio(drawn(text), drawn(cell));
          expect(`${palette.name}/${hue} depth ${depth} ${cell.hex}: ${ratio.toFixed(3)}`).toMatch(
            ratio >= TEXT_FLOOR ? /./ : /^$/,
          );
        }
      }
    }
  });
});

describe("open trigger, its band, and a nested band are mutually distinguishable on every theme", () => {
  // Each pair is measured on the colours the terminal draws: at 256 the band's
  // colours are rounded to the xterm cube, and bandFor holds the same floors
  // there (brandon-theme-picker-bgw.ddk); at ansi on the ANSI table's nominal
  // colours, as rich-js `drawnColour` rounds them.
  /** Every (lineage, depth) whose pair, as drawn at `drawnAt`, falls below `floor`, named. */
  function below(
    drawnAt: ColorDepth,
    floor: number,
    pair: (palette: Palette, hue: DecorHue, ground: Ground, depth: number) => [ColorRgba, ColorRgba],
    depths: readonly number[] = DEPTHS,
  ): string[] {
    const shown = shownAt(drawnAt);
    return LINEAGES.flatMap(({ palette, hue, ground, name }) =>
      depths.flatMap((depth) => {
        const [a, b] = pair(palette, hue, ground, depth);
        const d = deltaE(shown(a), shown(b));
        return d < floor ? [`${name} depth ${depth}: ${d.toFixed(4)}`] : [];
      }),
    );
  }

  test.each(DRAWN)("a trigger stands off the plane it opens (depth %s)", (drawnAt) => {
    expect(
      below(drawnAt, BAND_FLOORS.triggerPlane, (p, hue, ground, depth) => {
        const { state, plane } = bandFor(p, { hue, depth, ground }, drawnAt);
        return [state, plane];
      }),
    ).toEqual([]);
  });

  test.each(DRAWN)("a nested band's plane stands off the plane it is nested in (depth %s)", (drawnAt) => {
    // Covered over the depths a bar reaches: the bundled 🍫 → tab → ⚙ → style
    // list is depth 3, so the adjacent-plane pairs are (0,1), (1,2) and (2,3).
    // Between depths 2 and 3 BAND_RECESSION.cap leaves 0.05 of recession and
    // hueAtDepth has wrapped back onto a hue already used, so it is the plane
    // search's twelfths that hold the pair apart (STYLED below covers it under
    // every style, where it fell short before them).
    expect(
      below(
        drawnAt,
        BAND_FLOORS.nestedPlane,
        (p, hue, ground, depth) => [
          bandFor(p, { hue, depth, ground }, drawnAt).plane,
          bandFor(p, { hue, depth: depth + 1, ground }, drawnAt).plane,
        ],
        [0, 1, 2],
      ),
    ).toEqual([]);
  });

  // The settings menu is drawn in the styled palette, and a style is what
  // brought adjacent planes together at depth 3: under `muted` they stood
  // ΔE .009 apart in truecolor and drew as one colour at 256 and ansi. One
  // test per depth and style, as the shortfall tests above are split.
  test.each(DRAWN.flatMap((drawnAt) => STYLE_NAMES.map((style) => [drawnAt, style] as const)))(
    "under a style, every band through depth 3 stands off its trigger and the plane it is nested in (depth %s, style %s)",
    (drawnAt, style) => {
      const shown = shownAt(drawnAt);
      const wrong = STYLED.filter((styled) => styled.style === style).flatMap(({ name, palette }) =>
        GROUNDS.flatMap(({ name: where, ground }) =>
          DEPTHS.flatMap((depth) => {
            const band = bandFor(palette, { hue: OPEN_HUE, depth, ground }, drawnAt);
            const trigger = deltaE(shown(band.state), shown(band.plane));
            const nested =
              depth === 0
                ? Infinity
                : deltaE(shown(band.plane), shown(bandFor(palette, { hue: OPEN_HUE, depth: depth - 1, ground }, drawnAt).plane));
            return [
              ...(trigger < BAND_FLOORS.triggerPlane ? [`${name}@${where} depth ${depth} trigger ${trigger.toFixed(4)}`] : []),
              ...(nested < BAND_FLOORS.nestedPlane ? [`${name}@${where} depth ${depth} nested ${nested.toFixed(4)}`] : []),
            ];
          }),
        ),
      );
      expect(wrong).toEqual([]);
    },
  );

  // [LAW:verifiable-goals] brandon-menus-sjhy.b9w: a band row draws four colours
  // beside one another — the ✕ leading it (the band's state), a trigger open
  // in it (the next band's state) and its two items — and rich-js joins two
  // cells whose drawn backgrounds stand under SEAM_MIN_DELTA_E with its thin
  // divider, so they read as one. Every pair stands apart as drawn, no item is
  // the plane, or the band names the pair it stands short on — a pair with the
  // open trigger named by the band that trigger opens, which is open exactly
  // when that trigger is drawn.
  const seamOf = (band: ReturnType<typeof bandFor>, opened: ColorRgba, drawnAt: ColorDepth) => {
    const shown = shownAt(drawnAt);
    const row = { trigger: band.state, "low item": band.items[0], "high item": band.items[1], "open trigger": opened };
    const names = Object.keys(row) as Array<keyof typeof row>;
    return names.flatMap((a, i) =>
      names.slice(i + 1).flatMap((b) =>
        deltaE(shown(row[a]), shown(row[b])) >= SEAM_MIN_DELTA_E ? [] : [`${a} and ${b}`],
      ),
    );
  };
  test.each(DRAWN)("a band row's colours stand a seam apart, or the band names the pair (depth %s)", (drawnAt) => {
    const shown = shownAt(drawnAt);
    const unreported = LINEAGES.flatMap(({ palette, hue, ground, name }) =>
      DEPTHS.flatMap((depth) => {
        const band = bandFor(palette, { hue, depth, ground }, drawnAt);
        const nested = bandFor(palette, { hue, depth: depth + 1, ground }, drawnAt);
        const onPlane = band.items.some((item) => shown(item).hex === shown(band.plane).hex);
        // An open trigger's seam is named by the band it opens, beside the
        // colour of the band it sits in; every other pair by the band itself.
        const short = seamOf(band, nested.state, drawnAt).filter((pair) => {
          const [first] = pair.split(" and ");
          const [owner, words] = pair.endsWith("open trigger")
            ? [nested, `a trigger open in a band and that band's ${first} stand`]
            : [band, `an open band's ${pair} stand`];
          return !owner.shortfalls.some((line) => line.includes(words));
        });
        return [...(onPlane ? [`${name} depth ${depth}: an item is the plane`] : []), ...short.map((pair) => `${name} depth ${depth}: ${pair}`)];
      }),
    );
    expect(unreported).toEqual([]);
  });

  test("in truecolor every bundled theme's band rows stand a seam apart under every bundled style but dim", () => {
    // The one exception is textual-dark under `dim`: its door band's state is
    // carried to black over a plane of #050505, and no two colours between
    // them stand .04 off each other and off black.
    const short = STYLED.flatMap(({ name, palette }) =>
      GROUNDS.flatMap(({ ground }) =>
        DEPTHS.flatMap((depth) => {
          const band = bandFor(palette, { hue: OPEN_HUE, depth, ground }, ColorDepth.TRUECOLOR);
          const opened = bandFor(palette, { hue: OPEN_HUE, depth: depth + 1, ground }, ColorDepth.TRUECOLOR).state;
          return seamOf(band, opened, ColorDepth.TRUECOLOR).map((pair) => `${name} depth ${depth}: ${pair}`);
        }),
      ),
    );
    expect([...new Set(short)]).toEqual(["textual-dark/dim depth 0: low item and high item"]);
  });

  test("a nested trigger's state shortfall names the remedy that clears it: another shade or style", () => {
    // A trigger in a band stands among that band's plane and ✕, which another
    // variation moves too little to clear (measured: of 128 such shortfalls,
    // another shade or style cleared all, another variation 48).
    const lines = STYLED.flatMap(({ palette }) =>
      GROUNDS.flatMap(({ ground }) =>
        ([1, 2, 3] as const).flatMap((depth) =>
          bandFor(palette, { hue: OPEN_HUE, depth, ground }, ColorDepth.TRUECOLOR).shortfalls.filter((line) =>
            line.includes("no open-trigger colour"),
          ),
        ),
      ),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => !line.endsWith("; another shade or style clears it"))).toEqual([]);
  });

  test("a nested trigger is told from the trigger that opened it wherever the theme tells their hues apart", () => {
    // A nested trigger is its hue standing off the plane it sits on, so two
    // hues the theme spells alike (`default`'s accent IS its primary) may open
    // alike — stated here, never skipped. Distinct hues stay apart.
    const DISTINCT_HUES = 0.015;
    const wrong = LINEAGES.flatMap(({ palette, hue, ground, name }) =>
      [0, 1].flatMap((depth) => {
        const [here, next] = [depth, depth + 1].map((d) => hueAtDepth(hue, d));
        if (paletteRole(palette, here!).hex === paletteRole(palette, next!).hex) return [];
        const d = deltaE(
          bandFor(palette, { hue, depth, ground }, ColorDepth.TRUECOLOR).state,
          bandFor(palette, { hue, depth: depth + 1, ground }, ColorDepth.TRUECOLOR).state,
        );
        return d >= DISTINCT_HUES ? [] : [`${name} ${here}->${next} ${d.toFixed(4)}`];
      }),
    );
    expect(wrong).toEqual([]);
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
    const disclosure: Disclosure = { hue: OPEN_HUE, depth: 0, ground: [{ hue: "secondary", shade: "darken-1" }] };
    for (const drawnAt of DRAWN) {
      // The plane, then any item seam it leaves no room for (which pairs a band
      // must report is held by the seam test above; this pins the wording).
      const [plane, ...seams] = bandFor(washed, disclosure, drawnAt).shortfalls;
      expect(plane).toMatch(
        new RegExp(
          `^theme "washed": an open band's plane stands ΔE 0\\.\\d{3} off the trigger that opened it as drawn at depth ${ColorDepth[drawnAt]}, under the 0\\.1 that tells them apart; another style clears it$`,
        ),
      );
      for (const seam of seams) {
        expect(seam).toMatch(
          new RegExp(
            `^theme "washed": an open band's (trigger|open trigger|low item|high item) and (open trigger|low item|high item) stand ΔE 0\\.\\d{3} apart as drawn at depth ${ColorDepth[drawnAt]}, under the 0\\.04 below which two cells in those colours are joined by a divider and read as one$`,
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
    const ground = rowGround({ variation: VARIATIONS.alt, shade: SHADES[floorOf("shade")] }, [row(0, 2), cell(0, 5)]);
    const disclosure: Disclosure = { hue: OPEN_HUE, depth: 0, ground };
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
