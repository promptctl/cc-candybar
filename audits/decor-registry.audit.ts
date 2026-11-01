// Registry-wide colour audits: every bundled theme × colour depth, through the
// colour model (src/themes/decor.ts). The failures these catch are
// theme-specific — a role's own text that only reads once moved, a pole that
// misses the floor on a mid-luminance shade — so a sample proves nothing and
// the whole registry is walked, which takes minutes. That is why this is an
// audit and not a test (audits/README.md).
//
// [LAW:verifiable-goals] Each `describe` is one line of a Done-when
// (candybar-render-ai7.2/.3, candybar-theme-colours-6fq5.e5n), pinned over the
// WHOLE registry. The floor is TEXT_MIN_CONTRAST: every colour the bar draws
// behind text is one its palette names, and the text on it is chosen to read.

import { ColorDepth } from "@promptctl/rich-js";
import {
  contrastFor,
  contrastRatio,
  ensureContrast,
  Oklch,
  relativeLuminance,
} from "@promptctl/rich-js";
import {
  VARIATIONS,
  SHADES,
  DECOR_HUES,
  bandFor,
  decorEntryColour,
  decorEntryFor,
  decorationFor,
  textOn,
  TEXT_MIN_CONTRAST,
  type Decor,
  type DecorHue,
  type ShadeName,
} from "../src/themes/decor";
import {
  DRAWN,
  REGISTRY,
  SHADE_NAMES,
  TODAY,
  VARIATION_NAMES,
  cell,
  drawnGround,
  row,
  shownAt,
} from "../test/helpers/decor-vocabulary";

/** A decor whose menus open in `hue` at every depth, at dial position `shade`: every band a bar can open is one of these at depth 0. */
const openIn = (hue: DecorHue, shade: ShadeName): Decor => ({
  variation: { ...TODAY.variation, open: [hue] },
  shade: SHADES[shade],
});

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
              const { hue } = decorEntryFor(palette, decor, address, drawnAt);
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
              const own = palette.get(`text-${hue}`);
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

describe("done-when: text on a state cell is contrast-chosen and clears the text floor on every pair", () => {
  test("is the theme pole on the side contrastFor names, slid that way only when it misses the floor", () => {
    for (const palette of REGISTRY) {
      const poles = [palette.get("background"), palette.get("foreground")];
      for (const shade of SHADE_NAMES) {
        for (const hue of DECOR_HUES) {
          const { state } = bandFor(palette, { decor: openIn(hue, shade), depth: 0 }, ColorDepth.TRUECOLOR);
          const text = textOn(palette, state, ColorDepth.TRUECOLOR);
          const side = contrastFor(state);
          const bestPole = poles.reduce((a, b) =>
            contrastRatio(side, b) < contrastRatio(side, a) ? b : a,
          );
          // The text lies on the side the max-contrast pick names — a light cell
          // gets darker text, a dark cell lighter — so a slide never carries it
          // through the background into the other polarity.
          const lighter = relativeLuminance(text) > relativeLuminance(drawnGround(state));
          expect([palette.name, shade, hue, lighter]).toEqual([palette.name, shade, hue, side.hex === "#ffffff"]);
          // A pole that already clears is returned untouched — the floor never
          // transforms text that was already legible.
          if (contrastRatio(drawnGround(state), bestPole) >= TEXT_MIN_CONTRAST) {
            expect([palette.name, shade, hue, text.hex]).toEqual([palette.name, shade, hue, bestPole.hex]);
          }
          expect([palette.name, shade, hue, contrastRatio(drawnGround(state), text) >= TEXT_MIN_CONTRAST]).toEqual([
            palette.name,
            shade,
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
      const poles = [palette.get("background"), palette.get("foreground")];
      const cells = [
        ...SHADE_NAMES.flatMap((shade) =>
          [...VARIATIONS.duo.hues, ...VARIATIONS.accent.hues]
            .flatMap((hue) => SHADES[shade].tones.map((tone) => ({ hue, shade: tone })))
            .map((entry) => decorEntryColour(palette, entry)),
        ),
        ...SHADE_NAMES.flatMap((shade) =>
          DECOR_HUES.flatMap((hue) => {
            const band = bandFor(palette, { decor: openIn(hue, shade), depth: 0 }, ColorDepth.TRUECOLOR);
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
