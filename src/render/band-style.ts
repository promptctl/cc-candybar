// The state region, as Styles: the seam between `src/themes/decor.ts` (which
// computes COLOURS for a disclosure's trigger, plane and items) and the render
// walk (which paints CELLS). rich-js owns the colour math and decor.ts the
// policy; this module only lifts a colour into the Style a cell wears.
// [LAW:one-way-deps] Imports flow themes → here → the walk and the picker.

import {
  ColorSpec,
  ensureContrast,
  Style,
  type ColorDepth,
} from "@promptctl/rich-js";
import type { ColorRgba, Palette } from "@promptctl/rich-js";
import { DISCLOSURE_CLOSE_ROLE } from "../config/disclosure.js";
import {
  bandItem,
  TEXT_MIN_CONTRAST,
  textOn,
  type Decoration,
  type PlacedStep,
} from "../themes/decor.js";
import type { ActiveSegment } from "./active-segment.js";

/**
 * The Style of a cell in the state region: `background` as its colour, text as
 * whichever theme pole reads better on it. A fixed foreground measurably fails
 * on pure hues (design doc, Decisions), so text on a state cell is CHOSEN, never
 * inherited from the segment's `fg:`. [LAW:one-source-of-truth] The one
 * spelling, so a trigger, a band's plane and a band's items agree on how text
 * meets a state colour.
 */
export function stateCell(
  palette: Palette,
  background: ColorRgba,
  drawnAt: ColorDepth,
): Style {
  return new Style({
    bgcolor: ColorSpec.fromRgba(background),
    color: ColorSpec.fromRgba(textOn(palette, background, drawnAt)),
  });
}

/**
 * The Style of a closed cell wearing its decoration: the tint, and the text
 * the decoration pairs with it — what the walk draws a decorated cell in
 * (resolveSegmentColors), so a preview of the bar draws a cell as the bar does.
 */
export function decoratedCell({
  tint,
  text,
}: Pick<Decoration, "tint" | "text">): Style {
  return new Style({
    bgcolor: ColorSpec.fromRgba(tint),
    color: ColorSpec.fromRgba(text),
  });
}

/**
 * The text of a close glyph — a body's lead ✕, a picker's ✕ — drawn on
 * `ground`: the theme's `DISCLOSURE_CLOSE_ROLE` with its hue kept, its
 * lightness moved by rich-js `ensureContrast` until it clears
 * `TEXT_MIN_CONTRAST` at the drawn depth — the same floor and the same
 * function `readableOn` is. Text only: the cell's ground is whatever it is laid
 * on.
 */
export function closeOn(
  palette: Palette,
  ground: ColorRgba,
  drawnAt: ColorDepth,
): Style {
  return new Style({
    color: ColorSpec.fromRgba(
      ensureContrast(
        palette.get(DISCLOSURE_CLOSE_ROLE),
        ground,
        TEXT_MIN_CONTRAST,
        drawnAt,
      ),
    ),
  });
}

/**
 * A state cell whose text is the close glyph's: `background` as the ground,
 * `closeOn` it as the text — what the ✕ leading an open body wears on its
 * trigger's state colour.
 */
export function closeCell(
  palette: Palette,
  background: ColorRgba,
  drawnAt: ColorDepth,
): Style {
  return Style.combine([
    stateCell(palette, background, drawnAt),
    closeOn(palette, background, drawnAt),
  ]);
}

/**
 * The Style of item `step` in the band the active segment opens. The band is
 * an instance, so the step arrives placed by the instance's own distribution —
 * the `{{ menu }}`'s authored `distribution` option, or the default.
 */
export function bandItemStyle(
  active: ActiveSegment,
  step: PlacedStep,
  drawnAt: ColorDepth,
): Style {
  return decoratedCell(
    bandItem(active.palette, active.disclosure, step, drawnAt),
  );
}
