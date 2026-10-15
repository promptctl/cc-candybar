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
  getThemePalette,
  listThemePalettes,
  Oklch,
  Palette,
  relativeLuminance,
  transposePalette,
} from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { DEFAULT_SHADE, DEFAULT_VARIATION } from "../src/themes/policy";
import {
  BAND_FLOORS,
  BAND_RECESSION,
  BAND_WINDOW,
  VARIATIONS,
  SHADES,
  DECOR_HUES,
  OPEN_HUE,
  DEFAULT_DISTRIBUTION,
  DISTRIBUTION_NAMES,
  DISTRIBUTIONS,
  LEVEL_DECAY,
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
const TWO_STEP: Decor = { variation: VARIATIONS["duo"], shade: SHADES[DEFAULT_SHADE] };
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
    expect(DEFAULT_SHADE).toBe("middle");
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
              const own = paletteRole(palette, `text-${hue}`);
              if (contrastRatio(shown(tint), shown(own)) < TEXT_MIN_CONTRAST) moved++;
              else if (text.hex === own.hex) kept++;
              else wrong.push(`${where}: ${text.hex}, not its own ${own.hex}, which reads`);
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
const DEPTH_HUES = [0, 1, 2].map((depth) => hueAtDepth(OPEN_HUE, depth));

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

  test("a row no colour stands off draws the colour standing furthest off its nearest cell, and says how far that is", () => {
    // A row of black, grey and white: every colour sits within 2.2:1 of one.
    const roles = new Map<string, ColorRgba>([
      ["accent", new ColorRgba(0xd0, 0x70, 0x30)],
      ["secondary-darken-1", new ColorRgba(0, 0, 0)],
      ["secondary", new ColorRgba(0x77, 0x77, 0x77)],
      ["secondary-lighten-1", new ColorRgba(0xff, 0xff, 0xff)],
    ]);
    const straddling = new Palette("straddling", true, roles);
    const ground: Ground = SHADES.middle.tones.map((shade) => ({ hue: "secondary", shade }));
    const cells = groundCells(straddling, ground);
    expect(someColourClears(cells)).toBe(false);
    const { state, short } = stateFor(straddling, "accent", cells, ColorDepth.TRUECOLOR);
    const nearest = (c: ColorRgba): number => Math.min(...cells.map((x) => contrastRatio(c, x)));
    expect(short).toBe(nearest(state));
    expect(short!).toBeLessThan(STATE_FLOOR);
    // At least as far off its nearest cell as the hue itself or either end of
    // the lightness axis.
    for (const other of [paletteRole(straddling, "accent"), new ColorRgba(0, 0, 0), new ColorRgba(255, 255, 255)]) {
      expect(nearest(state)).toBeGreaterThanOrEqual(nearest(other) - 1e-9);
    }
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
          [0, 1, 2].flatMap((depth) => {
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
const DEPTHS = [0, 1, 2] as const;
// The ground the band facts below are stated on where one suffices: a trigger
// in the default bar's first row, at the default shade.
const FIRST_ROW: Ground = rowGround(
  { variation: VARIATIONS[DEFAULT_VARIATION], shade: SHADES[DEFAULT_SHADE] },
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
    // band stands on that band's plane.
    for (const { palette, hue, ground } of LINEAGES) {
      for (const depth of [0, 1, 2, 3]) {
        const among =
          depth === 0
            ? groundCells(palette, ground)
            : [bandFor(palette, { hue, depth: depth - 1, ground }, ColorDepth.TRUECOLOR).plane];
        expect(bandFor(palette, { hue, depth, ground }, ColorDepth.TRUECOLOR).state.hex).toBe(
          stateFor(palette, hueAtDepth(hue, depth), among, ColorDepth.TRUECOLOR).state.hex,
        );
      }
    }
  });

  test("a trigger inside a band stands STATE_FLOOR off the plane it sits on, as drawn at every depth", () => {
    const wrong: string[] = [];
    for (const drawnAt of DRAWN) {
      const shown = shownAt(drawnAt);
      for (const { palette, hue, ground, name } of LINEAGES) {
        for (const depth of [1, 2]) {
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
  test("the plane is the state receded toward background by the depth's recession, capped — or, where that breaks a band floor, toward foreground, then as far as the cap", () => {
    let intoForeground = 0;
    for (const { palette, hue, ground } of LINEAGES) {
      for (const depth of [0, 1, 2, 3, 4]) {
        const { state, plane } = bandFor(palette, { hue, depth, ground }, ColorDepth.TRUECOLOR);
        const recession = Math.min(
          BAND_RECESSION.cap,
          BAND_RECESSION.base + BAND_RECESSION.perDepth * depth,
        );
        const toward = (pole: "background" | "foreground", amount: number): ColorRgba =>
          blendRgb(state, paletteRole(palette, pole), amount);
        // Into the background, as a band always has — unless that plane would
        // stand too near its trigger (a state the search carried to the
        // background itself) or the plane it hangs in: then into the
        // foreground, then each as far as the cap.
        const outer = depth === 0 ? [] : [bandFor(palette, { hue, depth: depth - 1, ground }, ColorDepth.TRUECOLOR).plane];
        const holds = (p: ColorRgba): boolean =>
          deltaE(drawnGround(state), drawnGround(p)) >= BAND_FLOORS.triggerPlane &&
          outer.every((o) => deltaE(drawnGround(o), drawnGround(p)) >= BAND_FLOORS.nestedPlane);
        const background = toward("background", recession);
        const expected =
          [
            background,
            toward("foreground", recession),
            toward("background", BAND_RECESSION.cap),
            toward("foreground", BAND_RECESSION.cap),
          ].find(holds) ?? background;
        if (expected.hex !== background.hex) intoForeground++;
        expect(plane.hex).toBe(expected.hex);
      }
    }
    // Non-vacuous: some band's background plane breaks a floor.
    expect(intoForeground).toBeGreaterThan(0);
    // The cap bites: depth 4 would be 0.98 uncapped, and 0.75 is the ceiling.
    expect(BAND_RECESSION.base + BAND_RECESSION.perDepth * 4).toBeGreaterThan(
      BAND_RECESSION.cap,
    );
  });

  test("items are placed along the plane→state axis by the band's distribution, inside the window", () => {
    const disclosure: Disclosure = { hue: "primary", depth: 0, ground: FIRST_ROW };
    for (const palette of THEMES) {
      const { state, plane } = bandFor(palette, disclosure, ColorDepth.TRUECOLOR);
      // `uniform` puts every item at the window's midpoint — the formula, once.
      const mid = bandItemFor(palette, disclosure, [
        { index: 0, count: 1, distribution: DISTRIBUTIONS.uniform },
      ], ColorDepth.TRUECOLOR);
      expect(mid.hex).toBe(
        blendRgb(plane, state, BAND_WINDOW.floor + BAND_WINDOW.span * 0.5).hex,
      );
      // `monotonic` walks the axis: each item is further from the plane than
      // the one before it, and none is the plane or the state (the window
      // keeps them off both ends).
      const distances = [0, 1, 2, 3].map((index) => {
        const item = bandItemFor(palette, disclosure, [
          { index, count: 4, distribution: DISTRIBUTIONS.monotonic },
        ], ColorDepth.TRUECOLOR);
        expect(item.hex).not.toBe(plane.hex);
        expect(item.hex).not.toBe(state.hex);
        return deltaE(item, plane);
      });
      for (let i = 1; i < distances.length; i++) {
        expect(distances[i]!).toBeGreaterThan(distances[i - 1]!);
      }
    }
  });

  test("a nested address folds the same way: each level decayed, the sum taken modulo 1", () => {
    const disclosure: Disclosure = { hue: "primary", depth: 0, ground: FIRST_ROW };
    const step = (index: number): PlacedStep => ({
      index,
      count: 4,
      distribution: DISTRIBUTIONS.monotonic,
    });
    // The documented fold, stated once: `d0 + d1·LEVEL_DECAY`, modulo 1.
    const expected = (palette: Palette, address: readonly PlacedStep[]) => {
      const { state, plane } = bandFor(palette, disclosure, ColorDepth.TRUECOLOR);
      const axis =
        address.reduce(
          (sum, { index, count, distribution }, level) =>
            sum + distribution(index, count) * LEVEL_DECAY ** level,
          0,
        ) % 1;
      return blendRgb(plane, state, BAND_WINDOW.floor + BAND_WINDOW.span * axis).hex;
    };
    for (const palette of THEMES) {
      const { state, plane } = bandFor(palette, disclosure, ColorDepth.TRUECOLOR);
      // A row of four under the second cell of a row of four: every nested
      // cell lands where the fold says, inside the window, and the four are
      // pairwise distinct — from each other and from their parent's own place.
      const parent = bandItemFor(palette, disclosure, [step(1)], ColorDepth.TRUECOLOR);
      const nested = [0, 1, 2, 3].map((index) => {
        const item = bandItemFor(palette, disclosure, [step(1), step(index)], ColorDepth.TRUECOLOR);
        expect(item.hex).toBe(expected(palette, [step(1), step(index)]));
        expect(item.hex).not.toBe(plane.hex);
        expect(item.hex).not.toBe(state.hex);
        return item.hex;
      });
      expect(new Set([parent.hex, ...nested]).size).toBe(5);
      // The row decides the coarse position and the cell refines it: the
      // same two steps in the other order land somewhere else.
      expect(bandItemFor(palette, disclosure, [step(3), step(0)], ColorDepth.TRUECOLOR).hex).not.toBe(
        bandItemFor(palette, disclosure, [step(0), step(3)], ColorDepth.TRUECOLOR).hex,
      );
      // A raw sum past 1 (0.875 + 0.875·0.37) wraps into the same window.
      const wrapped = bandItemFor(palette, disclosure, [step(3), step(3)], ColorDepth.TRUECOLOR);
      expect(wrapped.hex).toBe(expected(palette, [step(3), step(3)]));
      expect(deltaE(wrapped, plane)).toBeLessThan(deltaE(parent, plane));
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
            bandItemFor(palette, disclosure, [
              { index, count: 6, distribution: DISTRIBUTIONS[DEFAULT_DISTRIBUTION] },
            ], ColorDepth.TRUECOLOR),
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
    // Covered over the depths a bar reaches: the bundled 🍫 → ⚙ → picker is
    // depth 2, so the adjacent-plane pairs are (0,1) and (1,2). Depth 3 is
    // deliberately NOT covered: nothing shipped reaches it, and nothing holds
    // its planes apart — BAND_RECESSION.cap leaves 0.05 of recession between
    // depths 2 and 3 while hueAtDepth has wrapped back onto a hue already
    // used, and under a style adjacent planes there fall below the floor. A
    // trigger still stands off its own plane at depth 3 (the previous test).
    // The design doc's "Depth advances the hue" has the measurements.
    expect(
      below(
        drawnAt,
        BAND_FLOORS.nestedPlane,
        (p, hue, ground, depth) => [
          bandFor(p, { hue, depth, ground }, drawnAt).plane,
          bandFor(p, { hue, depth: depth + 1, ground }, drawnAt).plane,
        ],
        [0, 1],
      ),
    ).toEqual([]);
  });

  test.each(DRAWN)("a band item is drawn as neither its plane nor its trigger (depth %s)", (drawnAt) => {
    const shown = shownAt(drawnAt);
    const wrong = LINEAGES.flatMap(({ palette, hue, ground, name }) =>
      DEPTHS.flatMap((depth) => {
        const band = bandFor(palette, { hue, depth, ground }, drawnAt);
        return Array.from({ length: 6 }, (_, index) =>
          shown(bandItemFor(palette, { hue, depth, ground }, [{ index, count: 6, distribution: DISTRIBUTIONS["van-der-corput"] }], drawnAt)),
        ).flatMap((item, index) =>
          item.hex === shown(band.plane).hex || item.hex === shown(band.state).hex
            ? [`${name} depth ${depth} item ${index}`]
            : [],
        );
      }),
    );
    expect(wrong).toEqual([]);
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
  test("an item whose own place rounds onto its trigger takes the nearest place inward that is neither", () => {
    // textual-dark under `dim`, an `alt` row at the brightest shade: option 21
    // of 32 placed by golden angle sits .98 of the way up its window, where
    // truecolor rounds it onto the open trigger's own colour.
    const palette = STYLED.find(({ name }) => name === "textual-dark/dim")!.palette;
    const { ground } = GROUNDS.find(
      ({ name }) =>
        name === "secondary-lighten-1+secondary-lighten-2+secondary-lighten-3+accent-lighten-1+accent-lighten-2+accent-lighten-3",
    )!;
    const disclosure: Disclosure = { hue: OPEN_HUE, depth: 0, ground };
    const goldenAngle = DISTRIBUTIONS["golden-angle"];
    const { state, plane } = bandFor(palette, disclosure, ColorDepth.TRUECOLOR);
    // Non-vacuous: the item's own place is its trigger's colour, on a band
    // with room — its plane stands its floor off the trigger.
    expect(blendRgb(plane, state, BAND_WINDOW.floor + BAND_WINDOW.span * goldenAngle(21)).hex).toBe(state.hex);
    expect(deltaE(state, plane)).toBeGreaterThanOrEqual(BAND_FLOORS.triggerPlane);
    const item = bandItemFor(palette, disclosure, [{ index: 21, count: 32, distribution: goldenAngle }], ColorDepth.TRUECOLOR);
    expect([item.hex === plane.hex, item.hex === state.hex]).toEqual([false, false]);
  });

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
      expect(bandFor(washed, disclosure, drawnAt).shortfalls).toEqual([
        expect.stringMatching(
          new RegExp(
            `^theme "washed": an open band's plane stands ΔE 0\\.\\d{3} off the trigger that opened it as drawn at depth ${ColorDepth[drawnAt]}, under the 0\\.1 that tells them apart; another style clears it$`,
          ),
        ),
      ]);
      for (let index = 0; index < 6; index++) {
        expect(() => bandItemFor(washed, disclosure, [{ index, count: 6, distribution: VDC }], drawnAt)).not.toThrow();
      }
    }
  });
});

describe("no floor is measured where nothing is drawn in colour", () => {
  test("a band that stands short in truecolor reports nothing at colour depth none (DEFAULT)", () => {
    // textual-dark's first row under `alt`, turning from its navy to its
    // orange: no colour stands 2.2:1 off both.
    const textualDark = getThemePalette("textual-dark")!;
    const ground = rowGround({ variation: VARIATIONS.alt, shade: SHADES[DEFAULT_SHADE] }, [row(0, 2), cell(0, 5)]);
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
