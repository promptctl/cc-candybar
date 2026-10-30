// The vocabulary the colour-model tests and the nightly colour audits state
// their facts in: the bundled registry, the depths a terminal draws at, an
// address step, and a cell as the SGR writer draws it.
// [LAW:one-source-of-truth] Spelled once, so test/decor.test.ts and
// audits/decor-registry.audit.ts measure the same thing by the same words.

import { ColorDepth, drawnColour } from "@promptctl/rich-js";
import { ColorRgba, getThemePalette, listThemePalettes } from "@promptctl/rich-js";
import { floorOf } from "../../src/config/globals-fields";
import {
  DISTRIBUTIONS,
  SHADES,
  VARIATIONS,
  type AddressStep,
  type Decor,
  type ShadeName,
  type VariationName,
} from "../../src/themes/decor";

export const REGISTRY = listThemePalettes().map((name) => getThemePalette(name));
export const VARIATION_NAMES = Object.keys(VARIATIONS) as VariationName[];
export const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
export const DRAWN = [ColorDepth.TRUECOLOR, ColorDepth.EIGHT_BIT, ColorDepth.STANDARD] as const;

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
