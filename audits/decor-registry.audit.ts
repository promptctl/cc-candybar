// Registry-wide colour audits: every bundled theme × style × row ground ×
// colour depth, through the colour model (src/themes/decor.ts). The failures
// these catch are theme-specific — textual-dark's navy secondary beside its
// orange accent, a muted plane that rounds onto the one above it at 256 — so
// a sample proves nothing and the whole registry is walked, which takes
// minutes. That is why this is an audit and not a test (audits/README.md).
//
// [LAW:verifiable-goals] Each `describe` is one line of a Done-when
// (candybar-render-ai7.2/.3, candybar-theme-colours-6fq5.e5n), pinned over the
// WHOLE registry. "Distinguishable" is measured as ΔE in OKLab: luminance
// contrast cannot see two hues at one lightness, and a nested trigger differs
// from its parent by HUE. The floors are STATE_FLOOR, BAND_FLOORS,
// TEXT_MIN_CONTRAST and SEAM_MIN_DELTA_E, so a regression that moves any
// theme under one fails, naming it.

import { ColorDepth, drawnColour } from "@promptctl/rich-js";
import {
  blendRgb,
  ColorRgba,
  contrastFor,
  contrastRatio,
  ensureContrast,
  Oklch,
  Palette,
  relativeLuminance,
  SEAM_MIN_DELTA_E,
  transposePalette,
} from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  BAND_FLOORS,
  BAND_RECESSION,
  VARIATIONS,
  SHADES,
  OPEN_HUE,
  DEFAULT_DISTRIBUTION,
  DISTRIBUTION_NAMES,
  DISTRIBUTIONS,
  STATE_FLOOR,
  bandFor,
  bandItemFor,
  decorEntryColour,
  decorEntryFor,
  decorationFor,
  hueAtDepth,
  paletteRole,
  rowGround,
  shadeRole,
  stateFor,
  textOn,
  TEXT_MIN_CONTRAST,
  vocabularyOf,
  type Decor,
  type DecorHue,
  type Disclosure,
  type DistributionName,
  type Ground,
  type ShadeName,
  type VariationName,
  WHOLE_ROW,
  deltaE,
} from "../src/themes/decor";
import {
  DRAWN,
  REGISTRY,
  SHADE_NAMES,
  VARIATION_NAMES,
  cell,
  drawnGround,
  row,
  shownAt,
} from "../test/helpers/decor-vocabulary";

const STYLED = REGISTRY.flatMap((base) =>
  Object.entries(DEFAULT_DSL_CONFIG.styles).map(([style, key]) => ({
    name: `${base.name}/${style}`,
    style,
    palette: transposePalette(base, key),
  })),
);
const STYLE_NAMES = Object.keys(DEFAULT_DSL_CONFIG.styles);

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

const DEPTHS = [0, 1, 2, 3] as const;

/**
 * Every lineage a bar can open, named so a failure says which: every bar
 * trigger opens OPEN_HUE (decorationFor), from a row on any ground, and each
 * band nested in it a depth further.
 */
const LINEAGES = REGISTRY.flatMap((palette) =>
  GROUNDS.map(({ name, ground }) => ({ palette, hue: OPEN_HUE as DecorHue, ground, name: `${palette.name}@${name}` })),
);

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

describe("done-when: a decorated cell's text clears the text floor on every theme as drawn", () => {
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

describe("done-when: an open trigger stands STATE_FLOOR off every closed cell of the row it stands in", () => {
  // One test per depth and style, so a shortfall is reported under the depth
  // and style it stands in rather than somewhere in one walk of everything.
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

describe("depth advances the hue, over every lineage", () => {
  test("a trigger wears the state of the band it opens — one expression at every depth", () => {
    // A bar trigger (depth 0) stands among its row's cells; a trigger inside a
    // band among what it is drawn beside there: that band's plane, and its
    // state, which the ✕ leading the trigger's row wears (b9w).
    for (const { palette, hue, ground, name } of LINEAGES) {
      let among: readonly ColorRgba[] = groundCells(palette, ground);
      for (const depth of [0, 1, 2, 3]) {
        const search = stateFor(palette, hueAtDepth(hue, depth), among, ColorDepth.TRUECOLOR);
        const band = bandFor(palette, { hue, depth, ground }, ColorDepth.TRUECOLOR);
        expect([name, depth, band.state.hex]).toEqual([name, depth, search.state.hex]);
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
    for (const { palette, hue, ground, name } of LINEAGES) {
      for (const depth of [0, 1, 2, 3, 4]) {
        const { state, plane } = bandFor(palette, { hue, depth, ground }, ColorDepth.TRUECOLOR);
        const outer = depth === 0 ? [] : [bandFor(palette, { hue, depth: depth - 1, ground }, ColorDepth.TRUECOLOR).plane];
        const expected = recededPlane(palette, state, depth, outer);
        if (expected.plane.hex !== expected.background.hex) intoForeground++;
        expect([name, depth, plane.hex]).toEqual([name, depth, expected.plane.hex]);
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
});

describe("text on every band cell clears the text floor", () => {

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
