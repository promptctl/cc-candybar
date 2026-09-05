// The state region, as Styles: the seam between `src/themes/decor.ts` (which
// computes COLOURS for a disclosure's trigger, plane and items) and the render
// walk (which paints CELLS). rich-js owns the colour math and decor.ts the
// policy; this module only lifts a colour into the Style a cell wears.
// [LAW:one-way-deps] Imports flow themes → here → the walk and the picker.

import { ColorSpec, Style } from "@promptctl/rich-js";
import type { ColorRgba, Palette } from "@promptctl/rich-js";
import { bandItemFor, textOn, type AddressStep } from "../themes/decor.js";
import type { ActiveSegment } from "./active-segment.js";

/**
 * The Style of a cell in the state region: `background` as its colour, text as
 * whichever theme pole reads better on it. A fixed foreground measurably fails
 * on pure hues (design doc, Decisions), so text on a state cell is CHOSEN, never
 * inherited from the segment's `fg:`. [LAW:one-source-of-truth] The one
 * spelling, so a trigger, a band's floor and a band's items agree on how text
 * meets a state colour.
 */
export function stateCell(palette: Palette, background: ColorRgba): Style {
  return new Style({
    bgcolor: ColorSpec.fromRgba(background),
    color: ColorSpec.fromRgba(textOn(palette, background)),
  });
}

/**
 * The Style of item `step` in the band the active segment opens. The band is
 * an instance, so the step arrives placed by the instance's own distribution —
 * the `{{ menu }}`'s authored `distribution` option, or the default.
 */
export function bandItemStyle(active: ActiveSegment, step: AddressStep): Style {
  return stateCell(
    active.palette,
    bandItemFor(active.palette, active.disclosure, [step]),
  );
}
