// [LAW:verifiable-goals] Pinned as a property over generated tree SHAPES, not hand-picked
// branches. [LAW:behavior-not-structure] Every assertion is bytes out for addresses in.

import {
  blendRgb,
  ColorRgba,
  contrastRatio,
  getThemePalette,
  listThemePalettes,
  Oklch,
  Palette,
} from "@promptctl/rich-js";
import {
  BAND_RECESSION,
  BAND_WINDOW,
  DECOR_AMTS,
  DECOR_BASES,
  DECOR_HUES,
  DECOR_MAX_AMOUNT,
  DECOR_VOCABULARY,
  DEFAULT_DISTRIBUTION,
  DISTRIBUTIONS,
  LEVEL_DECAY,
  STATE_FLOOR,
  STATE_PURE_AMOUNT,
  bandFor,
  bandItemFor,
  decorEntryColour,
  decorEntryFor,
  decorFor,
  hueAtDepth,
  paletteRole,
  stateFor,
  textOn,
  vocabularySelect,
  type Address,
  type AddressStep,
  type DecorHue,
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
    allNodes(shape, distribution).map(({ path, address }) => [
      pathKey(path),
      decorFor(DRACULA, address).hex,
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
    for (const semantic of ["error", "success", "warning"]) {
      expect(DECOR_HUES).not.toContain(semantic);
    }
  });

  test("every shipped theme carries every role the vocabulary names", () => {
    for (const name of listThemePalettes()) {
      const palette = getThemePalette(name);
      for (const role of [...DECOR_BASES, ...DECOR_HUES, "foreground", "background"] as const) {
        expect(() => paletteRole(palette, role)).not.toThrow();
      }
    }
  });

  test("a palette missing a role fails loudly, naming palette and role", () => {
    const bare = new Palette("bare", true, new Map<string, ColorRgba>());
    expect(() => paletteRole(bare, "accent")).toThrow(/"bare".*"accent"/);
    expect(() => decorFor(bare, [])).toThrow(/"bare"/);
  });
});

describe("the colour is mix(base, hue, amount) for the selected entry", () => {
  test("matches rich-js blendRgb of the theme's own two colours", () => {
    for (const { shape } of SHAPES.slice(0, 5)) {
      for (const { address } of allNodes(shape, DISTRIBUTIONS[DEFAULT_DISTRIBUTION])) {
        const { base, hue, amount } = decorEntryFor(address);
        const expected = blendRgb(paletteRole(DRACULA, base), paletteRole(DRACULA, hue), amount);
        expect(decorFor(DRACULA, address).hex).toBe(expected.hex);
      }
    }
  });

  test("ports the demo's pick formula: row then cell, decaying weight, rounded", () => {
    const DEMO_SIZE = 18;
    expect(DECOR_VOCABULARY).toHaveLength(DEMO_SIZE);
    const vdc = DISTRIBUTIONS["van-der-corput"];
    const address: Address = [
      { index: 0, count: 2, distribution: vdc },
      { index: 3, count: 6, distribution: vdc },
    ];
    expect(decorEntryFor(address)).toBe(DECOR_VOCABULARY[5]);
    expect(decorEntryFor(address)).toEqual({
      base: "surface-lighten-1",
      hue: "secondary",
      amount: 0.16,
    });
  });

  test("each step is placed by its OWN distribution: a heterogeneous address folds per step", () => {
    // A fold reusing one function for every step lands elsewhere; the per-step property is what this pins.
    const vdc = DISTRIBUTIONS["van-der-corput"];
    const mixed: Address = [
      { index: 0, count: 2, distribution: DISTRIBUTIONS.monotonic },
      { index: 3, count: 6, distribution: vdc },
    ];
    expect(decorEntryFor(mixed)).toBe(DECOR_VOCABULARY[9]);
    const uniformly = (distribution: Distribution): Address =>
      mixed.map((step) => ({ ...step, distribution }));
    expect(decorEntryFor(uniformly(vdc))).toBe(DECOR_VOCABULARY[5]);
    expect(decorEntryFor(uniformly(DISTRIBUTIONS.monotonic))).toBe(DECOR_VOCABULARY[8]);
  });

  test("the root selects entry 0", () => {
    // The empty address has no step to place, so no distribution can reach it.
    expect(decorEntryFor([])).toBe(DECOR_VOCABULARY[0]);
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
        const lone = drawFrom(rng, nodes);
        expect([name, seed, decorFor(DRACULA, lone.address).hex]).toEqual([
          name,
          seed,
          inOrder.get(pathKey(lone.path)),
        ]);
        for (const { path, address } of [...nodes].reverse()) {
          expect(decorFor(DRACULA, address).hex).toBe(inOrder.get(pathKey(path)));
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
    const only = { base: "surface", hue: "primary", amount: 0.16 } as const;
    for (const name of ALL_NAMES) {
      for (const { shape } of SHAPES) {
        for (const { address } of allNodes(shape, DISTRIBUTIONS[name])) {
          expect(vocabularySelect([only], address)).toBe(only);
        }
      }
    }
  });

  test("an empty vocabulary has nothing to select and says so", () => {
    expect(() => vocabularySelect([], [])).toThrow(/empty vocabulary/);
  });
});

// [LAW:verifiable-goals] Over the WHOLE registry: the failures the floor exists for were theme-specific.

/** The most-tinted cell `hue` produces on each base — the tint region's edge. */
function tintEdge(palette: Palette, hue: DecorHue) {
  return DECOR_BASES.map((base) =>
    decorEntryColour(palette, { base, hue, amount: DECOR_MAX_AMOUNT }),
  );
}

/** The pure form of `hue`: where the search starts. */
function pureHue(palette: Palette, hue: DecorHue) {
  return blendRgb(paletteRole(palette, "surface"), paletteRole(palette, hue), STATE_PURE_AMOUNT);
}

const REGISTRY = listThemePalettes().map((name) => getThemePalette(name));

describe("done-when: contrast(state, decorMax) >= 2.2 for every theme × hue × base", () => {
  test("holds over the whole registry", () => {
    for (const palette of REGISTRY) {
      for (const hue of DECOR_HUES) {
        const state = stateFor(palette, hue);
        for (const [i, tint] of tintEdge(palette, hue).entries()) {
          const ratio = contrastRatio(state, tint);
          expect([palette.name, hue, DECOR_BASES[i], ratio >= STATE_FLOOR]).toEqual([
            palette.name,
            hue,
            DECOR_BASES[i],
            true,
          ]);
        }
      }
    }
  });

  test("the search reaches foreground itself: solarized-dark's secondary lands on the pole", () => {
    const palette = getThemePalette("solarized-dark");
    expect(stateFor(palette, "secondary").hex).toBe(paletteRole(palette, "foreground").hex);
  });

  test("a hue that cannot clear even at foreground throws, naming palette and hue", () => {
    const grey = new ColorRgba(128, 128, 128);
    const roles = [...DECOR_BASES, ...DECOR_HUES, "foreground", "background"] as const;
    const flat = new Palette("flat", true, new Map(roles.map((role) => [role, grey])));
    expect(() => stateFor(flat, "primary")).toThrow(/"flat".*"primary".*foreground/);
  });
});

describe("done-when: the enforcement is a floor, not a transform", () => {
  test("a hue whose pure form already clears is byte-unchanged", () => {
    let untouched = 0;
    for (const palette of REGISTRY) {
      for (const hue of DECOR_HUES) {
        const pure = pureHue(palette, hue);
        const clears = tintEdge(palette, hue).every(
          (tint) => contrastRatio(pure, tint) >= STATE_FLOOR,
        );
        if (!clears) continue;
        untouched++;
        expect([palette.name, hue, stateFor(palette, hue).hex]).toEqual([
          palette.name,
          hue,
          pure.hex,
        ]);
      }
    }
    expect(untouched).toBeGreaterThan(0);
  });
});

describe("done-when: text on a state cell is contrast-chosen and clears 3:1 on every pair", () => {
  test("is the better of the theme's two poles, and clears 3:1 over the whole registry", () => {
    for (const palette of REGISTRY) {
      const poles = [paletteRole(palette, "background"), paletteRole(palette, "foreground")];
      for (const hue of DECOR_HUES) {
        const state = stateFor(palette, hue);
        const text = textOn(palette, state);
        const best = Math.max(...poles.map((pole) => contrastRatio(state, pole)));
        expect(poles.map((p) => p.hex)).toContain(text.hex);
        expect([palette.name, hue, contrastRatio(state, text)]).toEqual([palette.name, hue, best]);
        expect([palette.name, hue, contrastRatio(state, text) >= 3]).toEqual([
          palette.name,
          hue,
          true,
        ]);
      }
    }
  });
});

// [LAW:verifiable-goals] "Distinguishable" is ΔE in OKLab: contrast cannot see two hues at one lightness.

const THEMES = listThemePalettes().map((name) => getThemePalette(name));
const DEPTHS = [0, 1, 2] as const;

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

/** Every (theme, hue) pair, named so a failure says which. */
const LINEAGES = THEMES.flatMap((palette) =>
  DECOR_HUES.map((hue) => ({ palette, hue, name: `${palette.name}/${hue}` })),
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
    for (const { palette, hue } of LINEAGES) {
      for (const depth of [0, 1, 2, 3]) {
        expect(bandFor(palette, { hue, depth }).state.hex).toBe(
          stateFor(palette, hueAtDepth(hue, depth)).hex,
        );
      }
    }
  });
});

describe("a band is a plane", () => {
  test("the plane is the state receded toward background by the depth's recession, capped", () => {
    for (const { palette, hue } of LINEAGES) {
      const background = paletteRole(palette, "background");
      for (const depth of [0, 1, 2, 3, 4]) {
        const { state, plane } = bandFor(palette, { hue, depth });
        const recession = Math.min(
          BAND_RECESSION.cap,
          BAND_RECESSION.base + BAND_RECESSION.perDepth * depth,
        );
        expect(plane.hex).toBe(blendRgb(state, background, recession).hex);
      }
    }
    expect(BAND_RECESSION.base + BAND_RECESSION.perDepth * 4).toBeGreaterThan(
      BAND_RECESSION.cap,
    );
  });

  test("items are placed along the plane→state axis by the band's distribution, inside the window", () => {
    const disclosure = { hue: "primary", depth: 0 } as const;
    for (const palette of THEMES) {
      const { state, plane } = bandFor(palette, disclosure);
      const mid = bandItemFor(palette, disclosure, [
        { index: 0, count: 1, distribution: DISTRIBUTIONS.uniform },
      ]);
      expect(mid.hex).toBe(
        blendRgb(plane, state, BAND_WINDOW.floor + BAND_WINDOW.span * 0.5).hex,
      );
      const distances = [0, 1, 2, 3].map((index) => {
        const item = bandItemFor(palette, disclosure, [
          { index, count: 4, distribution: DISTRIBUTIONS.monotonic },
        ]);
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
    const disclosure = { hue: "primary", depth: 0 } as const;
    const step = (index: number): AddressStep => ({
      index,
      count: 4,
      distribution: DISTRIBUTIONS.monotonic,
    });
    // The documented fold, stated once: `d0 + d1·LEVEL_DECAY`, modulo 1.
    const expected = (palette: Palette, address: Address) => {
      const { state, plane } = bandFor(palette, disclosure);
      const axis =
        address.reduce(
          (sum, { index, count, distribution }, level) =>
            sum + distribution(index, count) * LEVEL_DECAY ** level,
          0,
        ) % 1;
      return blendRgb(plane, state, BAND_WINDOW.floor + BAND_WINDOW.span * axis).hex;
    };
    for (const palette of THEMES) {
      const { state, plane } = bandFor(palette, disclosure);
      const parent = bandItemFor(palette, disclosure, [step(1)]);
      const nested = [0, 1, 2, 3].map((index) => {
        const item = bandItemFor(palette, disclosure, [step(1), step(index)]);
        expect(item.hex).toBe(expected(palette, [step(1), step(index)]));
        expect(item.hex).not.toBe(plane.hex);
        expect(item.hex).not.toBe(state.hex);
        return item.hex;
      });
      expect(new Set([parent.hex, ...nested]).size).toBe(5);
      expect(bandItemFor(palette, disclosure, [step(3), step(0)]).hex).not.toBe(
        bandItemFor(palette, disclosure, [step(0), step(3)]).hex,
      );
      const wrapped = bandItemFor(palette, disclosure, [step(3), step(3)]);
      expect(wrapped.hex).toBe(expected(palette, [step(3), step(3)]));
      expect(deltaE(wrapped, plane)).toBeLessThan(deltaE(parent, plane));
    }
  });

  const TEXT_FLOOR = 2.15;

  test("text on every band cell is contrast-chosen and clears the band floor on every theme", () => {
    for (const { palette, hue } of LINEAGES) {
      for (const depth of DEPTHS) {
        const disclosure = { hue, depth };
        const { plane } = bandFor(palette, disclosure);
        const cells = [
          plane,
          ...[0, 1, 2, 3, 4, 5].map((index) =>
            bandItemFor(palette, disclosure, [
              { index, count: 6, distribution: DISTRIBUTIONS[DEFAULT_DISTRIBUTION] },
            ]),
          ),
        ];
        for (const cell of cells) {
          const ratio = contrastRatio(cell, textOn(palette, cell));
          expect(`${palette.name}/${hue} depth ${depth} ${cell.hex}: ${ratio.toFixed(3)}`).toMatch(
            ratio >= TEXT_FLOOR ? /./ : /^$/,
          );
        }
      }
    }
  });
});

describe("open trigger, its band, and a nested band are mutually distinguishable on every theme", () => {
  const TRIGGER_VS_PLANE = 0.1;
  const PLANE_VS_NESTED_PLANE = 0.035;
  const NESTED_TRIGGER_VS_PLANE = 0.08;

  /** Every (lineage, depth) whose pair falls below `floor`, named. */
  function below(
    floor: number,
    pair: (palette: Palette, hue: DecorHue, depth: number) => [ColorRgba, ColorRgba],
    depths: readonly number[] = DEPTHS,
  ): string[] {
    return LINEAGES.flatMap(({ palette, hue, name }) =>
      depths.flatMap((depth) => {
        const d = deltaE(...pair(palette, hue, depth));
        return d < floor ? [`${name} depth ${depth}: ${d.toFixed(4)}`] : [];
      }),
    );
  }

  test("a trigger stands off the plane it opens", () => {
    expect(
      below(TRIGGER_VS_PLANE, (p, hue, depth) => {
        const { state, plane } = bandFor(p, { hue, depth });
        return [state, plane];
      }),
    ).toEqual([]);
  });

  test("a nested band's plane stands off the plane it is nested in", () => {
    // Depth 3 is deliberately NOT covered; the design doc states the limit.
    expect(
      below(
        PLANE_VS_NESTED_PLANE,
        (p, hue, depth) => [
          bandFor(p, { hue, depth }).plane,
          bandFor(p, { hue, depth: depth + 1 }).plane,
        ],
        [0, 1],
      ),
    ).toEqual([]);
  });

  test("a nested trigger stands off the band it sits in", () => {
    expect(
      below(NESTED_TRIGGER_VS_PLANE, (p, hue, depth) => [
        bandFor(p, { hue, depth: depth + 1 }).state,
        bandFor(p, { hue, depth }).plane,
      ]),
    ).toEqual([]);
  });

  test("distinct hues yield distinct triggers; a theme whose vocabulary repeats a colour repeats its trigger", () => {
    // Two hues a theme spells with one colour open to one state — stated, never skipped.
    const DISTINCT_HUES = 0.015;
    const wrong = LINEAGES.flatMap(({ palette, hue, name }) => {
      const next = hueAtDepth(hue, 1);
      const sameColour =
        paletteRole(palette, hue).hex === paletteRole(palette, next).hex;
      const d = deltaE(
        bandFor(palette, { hue, depth: 0 }).state,
        bandFor(palette, { hue, depth: 1 }).state,
      );
      const ok = sameColour ? d === 0 : d >= DISTINCT_HUES;
      return ok ? [] : [`${name}->${next} same=${sameColour} ${d.toFixed(4)}`];
    });
    expect(wrong).toEqual([]);
  });
});
