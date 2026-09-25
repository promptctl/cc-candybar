// [LAW:verifiable-goals] candybar-render-ai7.1: the colour function. Each
// `describe` is one line of the ticket's Done-when, pinned as a property over
// generated tree SHAPES (test/helpers/seeded-trees.ts), not over hand-picked
// branches. [LAW:behavior-not-structure] Every assertion is about bytes out
// for addresses in; a different implementation of the same contract passes.

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
import {
  BAND_FLOORS,
  BAND_RECESSION,
  BAND_WINDOW,
  BAR_HUES,
  DECOR_HUES,
  DECOR_TONES,
  DECOR_VOCABULARY,
  DECOR_CHROMA_SHARE,
  OPEN_HUE,
  TONE_RECESS,
  TONE_TINT,
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
  decorationFor,
  hueAtDepth,
  paletteRole,
  stateFor,
  textOn,
  TEXT_MIN_CONTRAST,
  vocabularySelect,
  inBin,
  nearestPoint,
  type Address,
  type AddressStep,
  type PlacedStep,
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

const VDC = DISTRIBUTIONS["van-der-corput"];
const row = (index: number, count: number): AddressStep => ({ index, count, distribution: VDC, axis: "row" });
const cell = (index: number, count: number): AddressStep => ({ index, count, distribution: VDC, axis: "cell" });


// A cell as the SGR writer draws it: a translucent colour composited over
// black, the writer's substrate. Text is chosen against this, so it is what a
// floor is measured on.
const drawnGround = (c: ColorRgba): ColorRgba => c.compositeOver(new ColorRgba(0, 0, 0));

describe("the vocabulary", () => {
  test("is bar hues × tones, every entry the theme's own", () => {
    expect(DECOR_VOCABULARY).toHaveLength(BAR_HUES.length * DECOR_TONES.length);
    const seen = new Set(DECOR_VOCABULARY.map((e) => `${e.hue}|${e.tone}`));
    expect(seen.size).toBe(DECOR_VOCABULARY.length);
  });

  test("error/success/warning are absent from DECOR_HUES", () => {
    // The module also pins this at compile time; this is the runtime half so a
    // future edit fails BOTH `pnpm typecheck` and `pnpm test`.
    for (const semantic of ["error", "success", "warning"]) {
      expect(DECOR_HUES).not.toContain(semantic);
    }
  });

  test("the closed bar never wears the open hue", () => {
    // Runtime half of the module's compile-time theorem.
    expect(BAR_HUES).not.toContain(OPEN_HUE);
    expect(DECOR_HUES).toContain(OPEN_HUE);
  });

  test("every shipped theme carries every role the vocabulary names", () => {
    for (const name of listThemePalettes()) {
      const palette = getThemePalette(name);
      for (const role of ["surface", ...DECOR_HUES, "foreground", "background"] as const) {
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

describe("the colour is a tone of the row's hue", () => {
  test("matches rich-js mixAxes: surface receded toward background, to surface pulled toward the hue", () => {
    // The rule, stated once more in the test's own words: both ends of the
    // tone axis carry the hue's angle and the chroma share; the tone places
    // the cell between them.
    for (const palette of [DRACULA, getThemePalette("catppuccin-latte")]) {
      const O = (role: "surface" | "background" | DecorHue) => Oklch.fromRgba(paletteRole(palette, role));
      for (const entry of DECOR_VOCABULARY) {
        const hue = O(entry.hue);
        const deep = O("surface")
          .mixAxes(O("background"), { l: TONE_RECESS, c: 0, h: 0, alpha: 0 })
          .mixAxes(hue, { l: 0, c: DECOR_CHROMA_SHARE, h: 1, alpha: 0 });
        const tinted = O("surface").mixAxes(hue, { l: TONE_TINT, c: DECOR_CHROMA_SHARE, h: 1, alpha: 0 });
        const t = entry.tone;
        const expected = deep.mixAxes(tinted, { l: t, c: t, h: t, alpha: 0 }).toRgba();
        expect([palette.name, entry, decorEntryColour(palette, entry).hex]).toEqual([
          palette.name,
          entry,
          expected.hex,
        ]);
      }
    }
  });

  test("the row chooses the hue and the place in the row chooses the tone", () => {
    // Row 1 of 2 (vdc 0.5 × 2 = 1 -> secondary), cell 3 of 6 (vdc 0.75 × 3 =
    // 2.25 -> tone 1).
    expect(decorEntryFor([row(1, 2), cell(3, 6)])).toEqual({ hue: "secondary", tone: 1 });
    // Only the innermost row counts: a row stacked above the whole bar (edit
    // mode's reset banner wraps the content as row 1 of 2) recolours nothing.
    expect(decorEntryFor([row(1, 2), row(0, 2), cell(3, 6)])).toEqual({ hue: "primary", tone: 1 });
    // Anything nested inside a cell wears the cell's hue and tone: edit mode's
    // `+`/`-` wrap each content cell as the middle of three, and a `{ v }`
    // inside a cell stacks rows that are not the bar's.
    for (const nested of [[cell(1, 3)], [row(0, 2)], [row(0, 2), cell(2, 3)]]) {
      expect(decorEntryFor([row(1, 2), cell(3, 6), ...nested])).toEqual(
        decorEntryFor([row(1, 2), cell(3, 6)]),
      );
    }
    // A bar with no vertical container is one row, in the first bar hue.
    expect(decorEntryFor([cell(1, 4)])).toEqual({ hue: BAR_HUES[0], tone: 1 });
  });

  test("the tone step is placed by its OWN distribution", () => {
    // Cell 1 of 4: vdc 0.5 × 3 = 1.5 -> tone 1; monotonic 0.375 × 3 = 1.125 -> tone ½.
    expect(decorEntryFor([cell(1, 4)]).tone).toBe(1);
    expect(
      decorEntryFor([{ ...cell(1, 4), distribution: DISTRIBUTIONS.monotonic }]).tone,
    ).toBe(0.5);
  });

  test("no two of a row's first eight cells side by side share a tone", () => {
    // The reason there are three tones: van der Corput lands a row's first
    // eight cells on 0, 1, ½, 1, 0, 1, ½, 0 of them.
    const tones = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => decorEntryFor([row(0, 2), cell(i, 8)]).tone);
    expect(tones).toEqual([0, 1, 0.5, 1, 0, 1, 0.5, 0]);
  });

  test("no two rows side by side share a hue", () => {
    // Rows land at 0, ½, ¼, ¾, … and a row's hue is the half it falls in, so
    // the first bit alternates them however many rows the bar stacks.
    const hues = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => decorEntryFor([row(i, 8)]).hue);
    expect(hues).toEqual(Array.from({ length: 8 }, (_, i) => BAR_HUES[i % 2]));
  });

  test("a stack of rows inside a row restarts the alternation: siblings alternate, not lines", () => {
    // root { v: [ { v: [x, y] }, z ] }: y is the second of its stack, z the
    // second of the bar's, so the two lines touch in one hue. Stated, not
    // hidden — see decorEntryFor.
    expect(decorEntryFor([row(0, 2), row(1, 2)]).hue).toBe(decorEntryFor([row(1, 2)]).hue);
  });

  test("the root selects entry 0", () => {
    // The empty address has no step to place, so no distribution can reach it.
    expect(decorEntryFor([])).toEqual(DECOR_VOCABULARY[0]);
  });

  test("an open bar trigger opens the accent, whatever its row", () => {
    for (const address of [[row(0, 2), cell(2, 4)], [row(1, 2), cell(0, 4)]]) {
      expect(decorationFor(DRACULA, { kind: "bar", address }, ColorDepth.TRUECOLOR).disclosure).toEqual({
        hue: OPEN_HUE,
        depth: 0,
      });
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
    const only = { hue: "primary", tone: 0 } as const;
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

// --- candybar-render-ai7.2: the state floor -----------------------------------
// [LAW:verifiable-goals] Each `describe` is one line of the ticket's Done-when,
// over the WHOLE registry — the failures the floor exists for were
// theme-specific (textual-dark, textual-ansi, solarized-dark), so a sample
// proves nothing.

/** Every colour the closed bar can wear: what an open trigger must stand off. */
function barTints(palette: Palette) {
  return DECOR_VOCABULARY.map((entry) => decorEntryColour(palette, entry));
}

/** The pure form of `hue`: where the search starts. */
function pureHue(palette: Palette, hue: DecorHue) {
  return blendRgb(paletteRole(palette, "surface"), paletteRole(palette, hue), STATE_PURE_AMOUNT);
}

const REGISTRY = listThemePalettes().map((name) => getThemePalette(name));

describe("done-when: contrast(state, every bar tint) >= 2.2 for every theme × hue", () => {
  test("holds over the whole registry", () => {
    for (const palette of REGISTRY) {
      for (const hue of DECOR_HUES) {
        const state = stateFor(palette, hue, ColorDepth.TRUECOLOR);
        for (const [i, tint] of barTints(palette).entries()) {
          const ratio = contrastRatio(state, drawnGround(tint));
          expect([palette.name, hue, DECOR_VOCABULARY[i], ratio >= STATE_FLOOR]).toEqual([
            palette.name,
            hue,
            DECOR_VOCABULARY[i],
            true,
          ]);
        }
      }
    }
  });

  // A look is a palette the user can pick at runtime, and bandFor runs for every
  // segment, so a throw here is a ⚠ in every cell. dim pulls some themes'
  // foreground itself under the floor (atom-one-dark primary: 2.19). At 256
  // colours the trigger and every tint are each rounded to the xterm cube,
  // and the floor holds on what is drawn (brandon-theme-picker-bgw.ddk).
  test.each([ColorDepth.TRUECOLOR, ColorDepth.EIGHT_BIT, ColorDepth.STANDARD])(
    "holds under every bundled look, where the pole alone can fall short, on the colours drawn at depth %s",
    (drawnAt) => {
      const shown = (c: ColorRgba): ColorRgba => drawnColour(c, drawnAt);
      const wrong: string[] = [];
      for (const [look, key] of Object.entries(DEFAULT_DSL_CONFIG.looks)) {
        for (const base of REGISTRY) {
          const palette = transposePalette(base, key);
          for (const hue of DECOR_HUES) {
            const state = shown(stateFor(palette, hue, drawnAt));
            const worst = Math.min(...barTints(palette).map((t) => contrastRatio(state, shown(t))));
            if (worst < STATE_FLOOR) wrong.push(`${base.name}/${look}/${hue} ${worst.toFixed(2)}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  test("the search reaches foreground itself when only the pole clears", () => {
    // Every tint black; the foreground a grey that clears 2.2 against black
    // (2.41) where its eleven-twelfths blend toward black does not (2.18).
    const black = new ColorRgba(0, 0, 0);
    const roles = new Map<string, ColorRgba>([
      ...["background", "surface", ...DECOR_HUES].map((role) => [role, black] as const),
      ["foreground", new ColorRgba(75, 75, 75)],
    ]);
    const dim = new Palette("dim-pole", true, roles);
    expect(stateFor(dim, "accent", ColorDepth.TRUECOLOR).hex).toBe(paletteRole(dim, "foreground").hex);
  });

  test("a hue that cannot clear even beyond foreground throws, naming palette and hue", () => {
    // The bar's tints straddle the luminance cutoff — the deep end near black,
    // the tinted end near white — so sliding away from one slides toward the other.
    const grey = new ColorRgba(128, 128, 128);
    const roles = new Map<string, ColorRgba>([
      ["background", new ColorRgba(0, 0, 0)],
      ["surface", new ColorRgba(255, 255, 255)],
      ...[...DECOR_HUES, "foreground"].map((role) => [role, grey] as const),
    ]);
    const straddling = new Palette("straddling", true, roles);
    expect(() => stateFor(straddling, "primary", ColorDepth.TRUECOLOR)).toThrow(/"straddling".*"primary".*foreground/);
  });

  test("a band item drawn as its own plane throws, naming palette, hue and depth", () => {
    // The accent's state (#a3ad71) lands beside this background (#ada472), so
    // the plane receded from it is the state again within a few units, and the
    // first item, placed just above the plane, rounds onto it. Truecolor draws
    // from no table, so there is nothing to repair it to.
    const roles = new Map<string, ColorRgba>([
      ["background", new ColorRgba(0xad, 0xa4, 0x72)],
      ["surface", new ColorRgba(0x13, 0x3a, 0x6c)],
      ["foreground", new ColorRgba(0xa6, 0xbb, 0x67)],
      ["primary", new ColorRgba(0xfa, 0xbc, 0x8a)],
      ["secondary", new ColorRgba(0x2d, 0x16, 0x5f)],
      ["accent", new ColorRgba(0x87, 0x0b, 0xe8)],
    ]);
    const degenerate = new Palette("degenerate", true, roles);
    const first: PlacedStep = { index: 0, count: 3, distribution: DISTRIBUTIONS["van-der-corput"] };
    expect(() =>
      bandItemFor(degenerate, { hue: "accent", depth: 0 }, [first], ColorDepth.TRUECOLOR),
    ).toThrow(/"degenerate".*accent band item at depth 0 is drawn as its plane or its trigger/);
  });

  test("a band whose nested hue has no state still opens; the nested band throws only when it is asked for", () => {
    // Whether a hue finds a state depends on the hue: this accent clears on
    // its pure mix, while the primary nested under it clears nowhere. The
    // depth-0 band every closed cell deals must not inherit that refusal.
    const roles = new Map<string, ColorRgba>([
      ["background", new ColorRgba(110, 14, 61)],
      ["surface", new ColorRgba(59, 105, 208)],
      ["foreground", new ColorRgba(99, 36, 231)],
      ["primary", new ColorRgba(244, 76, 127)],
      ["secondary", new ColorRgba(37, 185, 27)],
      ["accent", new ColorRgba(93, 254, 37)],
    ]);
    const lopsided = new Palette("lopsided", true, roles);
    const nested = hueAtDepth(OPEN_HUE, 1);
    for (const drawnAt of [ColorDepth.TRUECOLOR, ColorDepth.EIGHT_BIT, ColorDepth.STANDARD]) {
      expect(() => bandFor(lopsided, { hue: OPEN_HUE, depth: 0 }, drawnAt)).not.toThrow();
      expect(() => bandFor(lopsided, { hue: OPEN_HUE, depth: 1 }, drawnAt)).toThrow(
        new RegExp(`"lopsided".*"${nested}".*state floor`),
      );
    }
  });
});

describe("done-when: the enforcement is a floor, not a transform", () => {
  test("a hue whose pure form already clears is byte-unchanged", () => {
    let untouched = 0;
    for (const palette of REGISTRY) {
      for (const hue of DECOR_HUES) {
        // As drawn: a translucent theme's colours are shown over black.
        const pure = drawnGround(pureHue(palette, hue));
        const clears = barTints(palette).every(
          (tint) => contrastRatio(pure, drawnGround(tint)) >= STATE_FLOOR,
        );
        if (!clears) continue;
        untouched++;
        expect([palette.name, hue, stateFor(palette, hue, ColorDepth.TRUECOLOR).hex]).toEqual([
          palette.name,
          hue,
          pure.hex,
        ]);
      }
    }
    // The measured registry: 41 of 69 pairs stay the pure mix. At least one
    // must, or the "floor not transform" clause is vacuous.
    expect(untouched).toBeGreaterThan(0);
  });
});

describe("done-when: text on a state cell is contrast-chosen and clears the text floor on every pair", () => {
  test("is the theme pole on the side contrastFor names, slid that way only when it misses the floor", () => {
    for (const palette of REGISTRY) {
      const poles = [paletteRole(palette, "background"), paletteRole(palette, "foreground")];
      for (const hue of DECOR_HUES) {
        const state = stateFor(palette, hue, ColorDepth.TRUECOLOR);
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
  });

  // A slide keeps its colour's OKLCH chroma and hue and moves only lightness, so
  // text carries the lineage of the pole it was slid from. On a mid-luminance
  // cell the pole that merely measures better can sit on the far side of the
  // background (39 of the registry's tints and band colours); sliding IT would
  // wear that pole's hue at the other polarity. The text must descend from the
  // pole on the side the max-contrast pick names — the theme's own dark or
  // light, only deepened.
  test("descends from the side's own pole: same chroma and hue, on every tint and band colour", () => {
    const hueGap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
    for (const palette of REGISTRY) {
      const poles = [paletteRole(palette, "background"), paletteRole(palette, "foreground")];
      const cells = [
        ...barTints(palette),
        ...DECOR_HUES.flatMap((hue) =>
          [0, 1, 2].flatMap((depth) => {
            const band = bandFor(palette, { hue, depth }, ColorDepth.TRUECOLOR);
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
        // top); hue is only a fact where both colours still carry some.
        const sameLineage =
          text.c <= pole.c + 0.005 &&
          (text.c < 0.02 || pole.c < 0.02 || hueGap(text.h, pole.h) < 6);
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
        expect(bandFor(palette, { hue, depth }, ColorDepth.TRUECOLOR).state.hex).toBe(
          stateFor(palette, hueAtDepth(hue, depth), ColorDepth.TRUECOLOR).hex,
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
        const { state, plane } = bandFor(palette, { hue, depth }, ColorDepth.TRUECOLOR);
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
    const disclosure = { hue: "primary", depth: 0 } as const;
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
    for (const { palette, hue } of LINEAGES) {
      for (const depth of DEPTHS) {
        const disclosure = { hue, depth };
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
    for (const { palette, hue } of LINEAGES) {
      for (const depth of DEPTHS) {
        const disclosure = { hue, depth };
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
  // Registry minima in truecolor at the time of writing (ΔE in OKLab):
  // trigger/plane 0.119 (textual-ansi primary), plane/nested plane 0.040
  // (rose-pine-dawn accent), nested trigger/enclosing plane 0.087 (rose-pine
  // primary). Each is measured on the colours the terminal draws: at 256 the
  // band's colours are rounded to the xterm cube, and bandFor holds the same
  // floors there (brandon-theme-picker-bgw.ddk).
  // At ansi the floors are measured on the ANSI table's nominal colours, as
  // rich-js `drawnColour` rounds them.
  const DRAWN = [ColorDepth.TRUECOLOR, ColorDepth.EIGHT_BIT, ColorDepth.STANDARD] as const;
  const shownAt =
    (drawnAt: ColorDepth) =>
    (c: ColorRgba): ColorRgba =>
      drawnColour(c, drawnAt);

  /** Every (lineage, depth) whose pair, as drawn at `drawnAt`, falls below `floor`, named. */
  function below(
    drawnAt: ColorDepth,
    floor: number,
    pair: (palette: Palette, hue: DecorHue, depth: number) => [ColorRgba, ColorRgba],
    depths: readonly number[] = DEPTHS,
  ): string[] {
    const shown = shownAt(drawnAt);
    return LINEAGES.flatMap(({ palette, hue, name }) =>
      depths.flatMap((depth) => {
        const [a, b] = pair(palette, hue, depth);
        const d = deltaE(shown(a), shown(b));
        return d < floor ? [`${name} depth ${depth}: ${d.toFixed(4)}`] : [];
      }),
    );
  }

  test.each(DRAWN)("a trigger stands off the plane it opens (depth %s)", (drawnAt) => {
    expect(
      below(drawnAt, BAND_FLOORS.triggerPlane, (p, hue, depth) => {
        const { state, plane } = bandFor(p, { hue, depth }, drawnAt);
        return [state, plane];
      }),
    ).toEqual([]);
  });

  test.each(DRAWN)("a nested band's plane stands off the plane it is nested in (depth %s)", (drawnAt) => {
    // Covered over the depths a bar reaches: the bundled 🍫 → ⚙ → picker is
    // depth 2, so the adjacent-plane pairs are (0,1) and (1,2). Depth 3 is
    // deliberately NOT covered — BAND_RECESSION.cap leaves 0.05 of recession
    // between depths 2 and 3 while hueAtDepth has wrapped back onto a hue
    // already used, and 20 lineages land at 0.016–0.034. The design doc's
    // "recession still separates what the wrapped hue no longer does" holds
    // for triggers (state vs plane, the next test) and not for adjacent
    // planes; the design doc states the limit (ai7.6).
    expect(
      below(
        drawnAt,
        BAND_FLOORS.nestedPlane,
        (p, hue, depth) => [
          bandFor(p, { hue, depth }, drawnAt).plane,
          bandFor(p, { hue, depth: depth + 1 }, drawnAt).plane,
        ],
        [0, 1],
      ),
    ).toEqual([]);
  });

  test.each(DRAWN)("a nested trigger stands off the band it sits in (depth %s)", (drawnAt) => {
    expect(
      below(drawnAt, BAND_FLOORS.nestedTriggerPlane, (p, hue, depth) => [
        bandFor(p, { hue, depth: depth + 1 }, drawnAt).state,
        bandFor(p, { hue, depth }, drawnAt).plane,
      ]),
    ).toEqual([]);
  });

  test.each(DRAWN)("a band item is drawn as neither its plane nor its trigger (depth %s)", (drawnAt) => {
    const shown = shownAt(drawnAt);
    const wrong = LINEAGES.flatMap(({ palette, hue, name }) =>
      DEPTHS.flatMap((depth) => {
        const band = bandFor(palette, { hue, depth }, drawnAt);
        return Array.from({ length: 6 }, (_, index) =>
          shown(bandItemFor(palette, { hue, depth }, [{ index, count: 6, distribution: DISTRIBUTIONS["van-der-corput"] }], drawnAt)),
        ).flatMap((item, index) =>
          item.hex === shown(band.plane).hex || item.hex === shown(band.state).hex
            ? [`${name} depth ${depth} item ${index}`]
            : [],
        );
      }),
    );
    expect(wrong).toEqual([]);
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
        bandFor(palette, { hue, depth: 0 }, ColorDepth.TRUECOLOR).state,
        bandFor(palette, { hue, depth: 1 }, ColorDepth.TRUECOLOR).state,
      );
      const ok = sameColour ? d === 0 : d >= DISTINCT_HUES;
      return ok ? [] : [`${name}->${next} same=${sameColour} ${d.toFixed(4)}`];
    });
    expect(wrong).toEqual([]);
  });
});
