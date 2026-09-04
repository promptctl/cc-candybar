// [LAW:verifiable-goals] candybar-render-ai7.1: the colour function. Each
// `describe` is one line of the ticket's Done-when, pinned as a property over
// generated tree SHAPES (test/helpers/seeded-trees.ts), not over hand-picked
// branches. [LAW:behavior-not-structure] Every assertion is about bytes out
// for addresses in; a different implementation of the same contract passes.

import { blendRgb, getThemePalette, listThemePalettes, Palette } from "@promptctl/rich-js";
import type { ColorRgba } from "@promptctl/rich-js";
import {
  DECOR_AMTS,
  DECOR_BASES,
  DECOR_HUES,
  DECOR_VOCABULARY,
  DEFAULT_DISTRIBUTION,
  DISTRIBUTIONS,
  decorEntryFor,
  decorFor,
  paletteRole,
  vocabularySelect,
  type Address,
  type Distribution,
  type DistributionName,
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
const BOUNDS = { maxDepth: 4, maxWidth: 6 };
const SHAPES = drawShapes(0xa17, 60, BOUNDS);
const ALL_NAMES = Object.keys(DISTRIBUTIONS) as DistributionName[];
const N_FREE: DistributionName[] = ["van-der-corput", "golden-angle", "uniform"];
const N_READING: DistributionName[] = ["monotonic", "ends-interleaved"];

/** path -> hex, computed by visiting each node alone. */
function colourMap(shape: Shape, distribution: Distribution): Map<string, string> {
  return new Map(
    allNodes(shape).map(({ path, address }) => [
      pathKey(path),
      decorFor(DRACULA, address, distribution).hex,
    ]),
  );
}

describe("the vocabulary", () => {
  test("is bases × hues × amounts, every entry the theme's own", () => {
    expect(DECOR_VOCABULARY).toHaveLength(
      DECOR_BASES.length * DECOR_HUES.length * DECOR_AMTS.length,
    );
    const seen = new Set(DECOR_VOCABULARY.map((e) => `${e.base}|${e.hue}|${e.amount}`));
    expect(seen.size).toBe(DECOR_VOCABULARY.length);
  });

  test("error/success/warning are absent from DECOR_HUES", () => {
    // The module also pins this at compile time; this is the runtime half so a
    // future edit fails BOTH `pnpm typecheck` and `pnpm test`.
    for (const semantic of ["error", "success", "warning"]) {
      expect(DECOR_HUES).not.toContain(semantic);
    }
  });

  test("every shipped theme carries every role the vocabulary names", () => {
    for (const name of listThemePalettes()) {
      const palette = getThemePalette(name);
      for (const role of [...DECOR_BASES, ...DECOR_HUES]) {
        expect(() => paletteRole(palette, role)).not.toThrow();
      }
    }
  });

  test("a palette missing a role fails loudly, naming palette and role", () => {
    const bare = new Palette("bare", true, new Map<string, ColorRgba>());
    expect(() => paletteRole(bare, "accent")).toThrow(/"bare".*"accent"/);
    expect(() => decorFor(bare, [], DISTRIBUTIONS.uniform)).toThrow(/"bare"/);
  });
});

describe("the colour is mix(base, hue, amount) for the selected entry", () => {
  test("matches rich-js blendRgb of the theme's own two colours", () => {
    for (const { shape } of SHAPES.slice(0, 5)) {
      for (const { address } of allNodes(shape)) {
        const { base, hue, amount } = decorEntryFor(address, DISTRIBUTIONS[DEFAULT_DISTRIBUTION]);
        const expected = blendRgb(paletteRole(DRACULA, base), paletteRole(DRACULA, hue), amount);
        expect(decorFor(DRACULA, address, DISTRIBUTIONS[DEFAULT_DISTRIBUTION]).hex).toBe(
          expected.hex,
        );
      }
    }
  });

  test("ports the demo's pick formula: row then cell, decaying weight, rounded", () => {
    // The pinned index is the demo's value at the demo's vocabulary size; a
    // resized vocabulary fails here first, naming the drift.
    const DEMO_SIZE = 18;
    expect(DECOR_VOCABULARY).toHaveLength(DEMO_SIZE);
    // Row 0 of 2 (vdc 0 -> 0), cell 3 of 6 (vdc 0.75 × 0.37 × 18 = 4.995 -> 5):
    // entry 5 is amount-major index 0, hue 1, base 2.
    const address: Address = [
      { index: 0, count: 2 },
      { index: 3, count: 6 },
    ];
    expect(decorEntryFor(address, DISTRIBUTIONS["van-der-corput"])).toBe(DECOR_VOCABULARY[5]);
    expect(decorEntryFor(address, DISTRIBUTIONS["van-der-corput"])).toEqual({
      base: "surface-lighten-1",
      hue: "secondary",
      amount: 0.16,
    });
  });

  test("the root selects entry 0", () => {
    for (const name of ALL_NAMES) {
      expect(decorEntryFor([], DISTRIBUTIONS[name])).toBe(DECOR_VOCABULARY[0]);
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
        const nodes = allNodes(shape);
        const inOrder = colourMap(shape, distribution);
        // A single node, evaluated with no other node ever visited.
        const lone = drawFrom(rng, nodes);
        expect([name, seed, decorFor(DRACULA, lone.address, distribution).hex]).toEqual([
          name,
          seed,
          inOrder.get(pathKey(lone.path)),
        ]);
        // The whole tree, evaluated back to front — a walk cursor would diverge here.
        for (const { path, address } of [...nodes].reverse()) {
          expect(decorFor(DRACULA, address, distribution).hex).toBe(inOrder.get(pathKey(path)));
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
        const nodes = allNodes(shape);
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
        const parents = allNodes(shape).filter(({ path }) => nodeAt(shape, path).children.length >= 2);
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
        const parents = allNodes(shape).filter(
          ({ path }) => path.length > 0 && nodeAt(shape, path).children.length >= 2,
        );
        if (parents.length === 0) continue;
        const target = drawFrom(rng, parents).path;
        const before = colourMap(shape, distribution);
        const after = colourMap(withChildrenPermuted(shape, target, rng), distribution);
        for (const { path } of allNodes(shape)) {
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
    const only = { base: "surface", hue: "primary", amount: 0.16 } as const;
    for (const name of ALL_NAMES) {
      for (const { shape } of SHAPES) {
        for (const { address } of allNodes(shape)) {
          expect(vocabularySelect([only], address, DISTRIBUTIONS[name])).toBe(only);
        }
      }
    }
  });

  test("an empty vocabulary has nothing to select and says so", () => {
    expect(() => vocabularySelect([], [], DISTRIBUTIONS.uniform)).toThrow(/empty vocabulary/);
  });
});
