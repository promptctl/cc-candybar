// The vocabulary the colour-model tests and the nightly colour audits state
// their facts in: the bundled registry, the depths a terminal draws at, an
// address step, and a cell as the SGR writer draws it.
// [LAW:one-source-of-truth] Spelled once, so test/decor.test.ts and
// audits/decor-registry.audit.ts measure the same thing by the same words.

import { ColorDepth, drawnColour, type Palette } from "@promptctl/rich-js";
import { ColorRgba, getThemePalette, listThemePalettes } from "@promptctl/rich-js";
import { floorOf } from "../../src/config/globals-fields";
import {
  DISTRIBUTIONS,
  KEYSTONE_HUE,
  SHADES,
  VARIATIONS,
  bandFor,
  hueOf,
  shadeRole,
  windowAt,
  type AddressStep,
  type Decor,
  type DecorHue,
  type RoleShade,
  type ShadeName,
  type VariationName,
} from "../../src/themes/decor";

export const REGISTRY = listThemePalettes().map((name) => getThemePalette(name));
export const VARIATION_NAMES = Object.keys(VARIATIONS) as VariationName[];
export const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
export const DRAWN = [ColorDepth.TRUECOLOR, ColorDepth.EIGHT_BIT, ColorDepth.STANDARD] as const;

// Textual's ladder for a role, darkest first — the rungs the dial's windows
// slide along, spelled here in the tests' own words.
export const LADDER: readonly RoleShade[] = [
  "darken-3",
  "darken-2",
  "darken-1",
  "base",
  "lighten-1",
  "lighten-2",
  "lighten-3",
];

/** A colour as the terminal shows it at `drawnAt`. */
export const shownAt =
  (drawnAt: ColorDepth) =>
  (c: ColorRgba): ColorRgba =>
    drawnColour(c, drawnAt);

export const VDC = DISTRIBUTIONS["van-der-corput"];
export const row = (index: number, count: number): AddressStep => ({ index, count, distribution: VDC, axis: "row", lineStart: 0, lineEnd: count - 1 });
export const cell = (index: number, count: number): AddressStep => ({ index, count, distribution: VDC, axis: "cell", lineStart: 0, lineEnd: count - 1 });

// A cell as the SGR writer draws it: a translucent colour composited over
// black, the writer's substrate. Text is chosen against this, so it is what a
// floor is measured on.
export const drawnGround = (c: ColorRgba): ColorRgba => c.compositeOver(new ColorRgba(0, 0, 0));

// The default bar's decor: the dial's floor variation at its floor shade.
export const TODAY: Decor = { variation: VARIATIONS[floorOf("variation")], shade: SHADES[floorOf("shade")] };

/**
 * Every colour, as `drawnAt` draws it, that the design stands beside the
 * pressed shade of the band `depth` deep under `decor`, in the tests' own
 * words: every tone of that band's own window, because its ✕ and blank leads
 * open each of its rows; and every tone its trigger can stand beside — for a
 * band opened from the bar, the bar's cells in each hue a bar row wears, else
 * the band one depth up: its items, and its ✕ and leads in that band's
 * pressed shade.
 * [LAW:one-source-of-truth] The one statement of those adjacencies the tests
 * hold the pressed shade to, and the closing sweep reads its exemption from.
 */
export function besidePress(palette: Palette, decor: Decor, depth: number, drawnAt: ColorDepth): ReadonlySet<string> {
  const { variation, shade } = decor;
  const dealt = (hue: DecorHue): string[] =>
    windowAt(palette, hue, shade, drawnAt).map((tone) => drawnColour(palette.get(shadeRole(hue, tone)), drawnAt).hex);
  const keystone: readonly DecorHue[] = variation.keystones.length > 0 ? [KEYSTONE_HUE] : [];
  const up = { decor, depth: depth - 1 };
  const beside =
    depth === 0
      ? [...variation.hues, ...keystone].flatMap(dealt)
      : [...dealt(hueOf(up)), drawnColour(bandFor(palette, up, drawnAt).state, drawnAt).hex];
  return new Set([...dealt(hueOf({ decor, depth })), ...beside]);
}
