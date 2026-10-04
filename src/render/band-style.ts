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
  bandItemFor,
  paletteRole,
  TEXT_MIN_CONTRAST,
  textOn,
  type PlacedStep,
  type Distribution,
  type Position,
} from "../themes/decor.js";
import type { OptionPalette, RenderPalettes } from "../config/option-domain.js";
import type { ActiveSegment } from "./active-segment.js";

/**
 * The Style of a cell in the state region: `background` as its colour, text as
 * whichever theme pole reads better on it. A fixed foreground measurably fails
 * on pure hues (design doc, Decisions), so text on a state cell is CHOSEN, never
 * inherited from the segment's `fg:`. [LAW:one-source-of-truth] The one
 * spelling, so a trigger, a band's floor and a band's items agree on how text
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
        paletteRole(palette, DISCLOSURE_CLOSE_ROLE),
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
  return stateCell(
    active.palette,
    bandItemFor(active.palette, active.disclosure, [step], drawnAt),
    drawnAt,
  );
}

/**
 * The Style of one option cell in a picker — the ONE rule a `{{ menu }}` body,
 * a bare `{{ picker }}` and a `{{ carousel }}` colour their options by
 * (brandon-picker-31z, brandon-menu-ia-q30.jl1).
 *
 * Two rules, selected by one VALUE: the option domain's own `paletteOf`, or its
 * absence. A generic domain has none, and an option is coloured by where it sits
 * in the band. A COLOUR-VALUED domain has one, and every option sits on the one
 * `ground` the caller names — a menu body's plane, the segment's own background
 * — with its TEXT in the palette picking it would put in force. Brandon: "Only
 * the foreground should be in the themes colors, it looks like shit when the
 * backgrounds are drawn differently, very messy." So the only thing that
 * differs between two options is the thing being chosen, and the list reads as
 * one menu.
 *
 * [LAW:dataflow-not-control-flow] The selection happens ONCE per picker, not per
 * cell — a picker is painted by whichever rule its domain handed in.
 */
export function optionItemStyle(
  active: ActiveSegment,
  distribution: Distribution,
  render: RenderPalettes,
  paletteOf: OptionPalette | undefined,
  drawnAt: ColorDepth,
  ground: ColorRgba,
): (position: Position, option: string) => Style {
  if (paletteOf === undefined) {
    return (position) =>
      bandItemStyle(active, { ...position, distribution }, drawnAt);
  }
  return (_position, option) =>
    appliedText(paletteOf(option, render), ground, drawnAt);
}

/**
 * The contrast an option label must clear against its ground: WCAG AA body
 * text. An option is text you have to READ to pick it, so it is not the
 * deliberately-recessive case 3.0 exists for. [LAW:no-silent-failure] rich-js
 * refuses to default this, because the threshold is the whole decision.
 */
const OPTION_TEXT_RATIO = 4.5;

/**
 * A colour-valued option: the shared ground, and the applied palette's own
 * `primary` as the text — hue preserved, OKLCH lightness slid by rich-js until
 * it clears AA on that ground. The hue is what identifies a theme (a bar under
 * a theme is mostly its hues), and it is also what tells the styles apart:
 * `vivid` and `muted` scale chroma, which moves a primary and leaves a
 * near-neutral background where it was.
 *
 * [LAW:one-source-of-truth] The contrast math is rich-js's (`ensureContrast`,
 * the same function the `readableOn` binding is). This is deliberately NOT
 * `textOn`: that picks a theme POLE for a decorative background, where the text
 * says nothing; here the text colour is itself information, so the hue must
 * survive and only its lightness may move.
 */
function appliedText(
  applied: Palette,
  ground: ColorRgba,
  drawnAt: ColorDepth,
): Style {
  return new Style({
    bgcolor: ColorSpec.fromRgba(ground),
    color: ColorSpec.fromRgba(
      ensureContrast(
        paletteRole(applied, "primary"),
        ground,
        OPTION_TEXT_RATIO,
        drawnAt,
      ),
    ),
  });
}
