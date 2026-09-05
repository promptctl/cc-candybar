// [LAW:verifiable-goals] candybar-render-ai7.1: the colour function. Each
// `describe` is one line of the ticket's Done-when, pinned as a property over
// generated tree SHAPES (test/helpers/seeded-trees.ts), not over hand-picked
// branches. [LAW:behavior-not-structure] Every assertion is about bytes out
// for addresses in; a different implementation of the same contract passes.

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
    // The module also pins this at compile time; this is the runtime half so a
    // future edit fails BOTH `pnpm typecheck` and `pnpm test`.
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
    // The pinned index is the demo's value at the demo's vocabulary size; a
    // resized vocabulary fails here first, naming the drift.
    const DEMO_SIZE = 18;
    expect(DECOR_VOCABULARY).toHaveLength(DEMO_SIZE);
    // Row 0 of 2 (vdc 0 -> 0), cell 3 of 6 (vdc 0.75 × 0.37 × 18 = 4.995 -> 5):
    // entry 5 is amount-major index 0, hue 1, base 2.
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
        // A single node, evaluated with no other node ever visited.
        const lone = drawFrom(rng, nodes);
        expect([name, seed, decorFor(DRACULA, lone.address).hex]).toEqual([
          name,
          seed,
          inOrder.get(pathKey(lone.path)),
        ]);
        // The whole tree, evaluated back to front — a walk cursor would diverge here.
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

// --- candybar-render-ai7.2: the state floor -----------------------------------
// [LAW:verifiable-goals] Each `describe` is one line of the ticket's Done-when,
// over the WHOLE registry — the failures the floor exists for were
// theme-specific (textual-dark, textual-ansi, solarized-dark), so a sample
// proves nothing.

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
    // Every role one grey: every candidate sits at contrast 1 against every tint.
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
    // The measured registry: 30 of 69 pairs stay the pure mix. At least one
    // must, or the "floor not transform" clause is vacuous.
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

// ─── candybar-render-ai7.3: disclosure depth — bands, nesting, trigger ────────
//
// [LAW:verifiable-goals] Each `describe` is one of the ticket's three rules or
// one line of its Done-when, pinned over EVERY shipped theme × hue × depth.
// "Distinguishable" is measured as ΔE in OKLab (Euclidean distance over the
// coordinates rich-js's `Oklch` exposes): luminance contrast cannot see two
// hues at one lightness, and a nested trigger differs from its parent by HUE.
// The floors are the measured registry minima rounded down — a regression
// that moves a theme below its own floor fails, whichever theme it is.

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
    // The cap bites: depth 4 would be 0.98 uncapped, and 0.75 is the ceiling.
    expect(BAND_RECESSION.base + BAND_RECESSION.perDepth * 4).toBeGreaterThan(
      BAND_RECESSION.cap,
    );
  });

  test("items are placed along the plane→state axis by the band's distribution, inside the window", () => {
    const disclosure = { hue: "primary", depth: 0 } as const;
    for (const palette of THEMES) {
      const { state, plane } = bandFor(palette, disclosure);
      // `uniform` puts every item at the window's midpoint — the formula, once.
      const mid = bandItemFor(palette, disclosure, {
        index: 0,
        count: 1,
        distribution: DISTRIBUTIONS.uniform,
      });
      expect(mid.hex).toBe(
        blendRgb(plane, state, BAND_WINDOW.floor + BAND_WINDOW.span * 0.5).hex,
      );
      // `monotonic` walks the axis: each item is further from the plane than
      // the one before it, and none is the plane or the state (the window
      // keeps them off both ends).
      const distances = [0, 1, 2, 3].map((index) => {
        const item = bandItemFor(palette, disclosure, {
          index,
          count: 4,
          distribution: DISTRIBUTIONS.monotonic,
        });
        expect(item.hex).not.toBe(plane.hex);
        expect(item.hex).not.toBe(state.hex);
        return deltaE(item, plane);
      });
      for (let i = 1; i < distances.length; i++) {
        expect(distances[i]!).toBeGreaterThan(distances[i - 1]!);
      }
    }
  });

  // Registry minimum: solarized-dark/accent's depth-1 plane (#3b5f6b) reads at
  // 2.188 against its better pole — the band floor sits just under STATE_FLOOR
  // (2.2), which governs the trigger, not the plane.
  const TEXT_FLOOR = 2.15;

  test("text on every band cell is contrast-chosen and clears the band floor on every theme", () => {
    for (const { palette, hue } of LINEAGES) {
      for (const depth of DEPTHS) {
        const disclosure = { hue, depth };
        const { plane } = bandFor(palette, disclosure);
        const cells = [
          plane,
          ...[0, 1, 2, 3, 4, 5].map((index) =>
            bandItemFor(palette, disclosure, {
              index,
              count: 6,
              distribution: DISTRIBUTIONS[DEFAULT_DISTRIBUTION],
            }),
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
  // Registry minima at the time of writing (ΔE in OKLab): trigger/plane 0.119
  // (textual-ansi primary), plane/nested plane 0.040 (rose-pine-dawn accent),
  // nested trigger/enclosing plane 0.087 (rose-pine primary).
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
    // Covered over the depths a bar reaches: the bundled ☰ → ⚙ → picker is
    // depth 2, so the adjacent-plane pairs are (0,1) and (1,2). Depth 3 is
    // deliberately NOT covered — BAND_RECESSION.cap leaves 0.05 of recession
    // between depths 2 and 3 while hueAtDepth has wrapped back onto a hue
    // already used, and 20 lineages land at 0.016–0.034. The design doc's
    // "recession still separates what the wrapped hue no longer does" holds
    // for triggers (state vs plane, the next test) and not for adjacent
    // planes; the design doc states the limit (ai7.6).
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
    // The model SELECTS from the theme and never synthesises, so two hues the
    // theme spells with one colour (`default`'s accent IS its primary) open
    // to one state — stated here, never skipped. Registry minimum over
    // distinct hues: 0.0196 (atom-one-dark's two purples).
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
