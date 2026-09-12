// The state region, as Styles: the seam between `src/themes/decor.ts` (which
// computes COLOURS for a disclosure's trigger, plane and items) and the render
// walk (which paints CELLS). rich-js owns the colour math and decor.ts the
// policy; this module only lifts a colour into the Style a cell wears.
// [LAW:one-way-deps] Imports flow themes → here → the walk and the picker.

import { ColorSpec, ensureContrast, Style } from "@promptctl/rich-js";
import type { ColorRgba, Palette } from "@promptctl/rich-js";
import {
  bandItemFor,
  paletteRole,
  textOn,
  type AddressStep,
  type Distribution,
  type Position,
} from "../themes/decor.js";
import type { OptionPalette } from "../config/option-domain.js";
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

/**
 * The Style of one option cell in a picker — the ONE rule both a `{{ menu }}`
 * body and a bare `{{ picker }}` colour their grids by (brandon-picker-31z).
 *
 * Two rules, selected by one VALUE: the option domain's own `paletteOf`, or its
 * absence. A generic domain has none, and an option is coloured by where it sits
 * in the band, exactly as before. A COLOUR-VALUED domain has one, and the cell
 * wears the ground of the palette picking it would put in force — which is the
 * whole point: choosing a theme means reading names, and a name's colour was
 * previously its address in the band, a fact about the grid rather than about the
 * choice. Under the painter the address drops out of the decision entirely, so
 * the only thing that differs between two cells is the thing being chosen.
 *
 * [LAW:dataflow-not-control-flow] The selection happens ONCE per picker, not per
 * cell — a picker is painted by whichever rule its domain handed in.
 *
 * The cell itself is `appliedCell` below.
 */
export function optionItemStyle(
  active: ActiveSegment,
  distribution: Distribution,
  base: Palette,
  paletteOf: OptionPalette | undefined,
): (position: Position, option: string) => Style {
  if (paletteOf === undefined) {
    return (position) => bandItemStyle(active, { ...position, distribution });
  }
  return (_position, option) => appliedCell(paletteOf(option, base));
}

/**
 * The contrast an option label must clear against its own ground: WCAG AA body
 * text. An option is text you have to READ to pick it, so it is not the
 * deliberately-recessive case 3.0 exists for. [LAW:no-silent-failure] rich-js
 * refuses to default this, because the threshold is the whole decision.
 */
const OPTION_TEXT_RATIO = 4.5;

/**
 * The cell a colour-valued option wears: the applied palette's own `background`,
 * with its own `primary` as the text — hue preserved, OKLCH lightness slid by
 * rich-js until it clears AA on that ground.
 *
 * The ground alone would not be enough, and the look picker is what proves it:
 * `vivid` and `muted` scale CHROMA, which leaves a near-neutral background
 * exactly where it was, so three of the six bundled looks would have rendered
 * byte-identical cells while picking them genuinely changes the bar — the same
 * class of lie as colouring an option by its address. The hue carries what the
 * ground cannot, and it is also the more identifying half for a theme: a bar
 * under a theme is mostly that theme's hues over its bases.
 *
 * [LAW:one-source-of-truth] The contrast math is rich-js's (`ensureContrast`,
 * the same function the `readableOn` binding is) — cc-candybar does no colour
 * arithmetic of its own. This is deliberately NOT `textOn`: that picks a theme
 * POLE for a decorative background, where the text says nothing; here the text
 * colour is itself information, so the hue must survive and only its lightness
 * may move.
 */
function appliedCell(applied: Palette): Style {
  const ground = paletteRole(applied, "background");
  return new Style({
    bgcolor: ColorSpec.fromRgba(ground),
    color: ColorSpec.fromRgba(
      ensureContrast(
        paletteRole(applied, "primary"),
        ground,
        OPTION_TEXT_RATIO,
      ),
    ),
  });
}
