// [LAW:one-type-per-behavior] How an option of a picker is DRAWN — the one
// rule a `{{ menu }}` body, a bare `{{ picker }}`, a `{{ carousel }}` and a
// `{{ swatches }}` row draw their options by, so no two of them can show one
// option two ways. A paint is the cell without its link: the picker that lays
// the option out lays the click over every span of it (`linkOver`).
//
// [LAW:one-way-deps] Imports flow themes → band-style → here → the pickers.

import { RichText, Style } from "@promptctl/rich-js";
import type { ColorDepth, ColorRgba, Palette } from "@promptctl/rich-js";
import type { Distribution, Position } from "../themes/decor.js";
import type { OptionPalette, RenderPalettes } from "../config/option-domain.js";
import type { ActiveSegment } from "./active-segment.js";
import { bandItemStyle, stateCell } from "./band-style.js";
import { swatch } from "./swatch.js";

// [LAW:locality-or-seam] An option's cell, as a VALUE the caller hands in: the
// picker names which option a cell holds, where it stands among them, and
// whether it is the one in force, and knows nothing of bands, palettes or
// swatches. The option was always sitting beside the call site and was never
// passed, which is why no cell could be a function of the choice being offered
// (brandon-picker-31z).
// `label` is what names the option in the cell — the option itself, or a
// catalogue's row of name and description.
export type ItemPaint = (
  position: Position,
  option: string,
  label: string,
  current: boolean,
) => RichText;

const cell = (text: string | RichText, style?: Style): RichText => {
  const drawn = typeof text === "string" ? new RichText(text, { style }) : text;
  drawn.overflow = "ignore";
  drawn.end = "";
  return drawn;
};

// The option in force reads as current: bold, on whatever it is drawn on.
const currentMark = (current: boolean): Style => new Style({ bold: current });

/**
 * The paint of a picker's options — two rules, selected by one VALUE: the
 * option domain's own `paletteOf`, or its absence.
 *
 * A generic domain has none, and an option is placed in the band by where it
 * stands among the others, as every band item is.
 *
 * A COLOUR-VALUED domain has one, and every option is its name written in the
 * text of the one `ground` the caller names — a menu body's plane, the
 * segment's own background — with the swatch of the palette picking it would
 * put in force beside it (brandon-theme-swatch-8v9r). Brandon: "Each theme
 * name has the same colour and background as the rest of the UI … each theme
 * name has a theme swatch to show its colours instead." The only thing that
 * differs between two options is the swatch, which is the thing being chosen.
 *
 * [LAW:dataflow-not-control-flow] The selection happens ONCE per picker, not
 * per cell — a picker is painted by whichever rule its domain handed in.
 */
export function optionPaint(
  active: ActiveSegment,
  distribution: Distribution,
  render: RenderPalettes,
  paletteOf: OptionPalette | undefined,
  drawnAt: ColorDepth,
  ground: ColorRgba,
): ItemPaint {
  if (paletteOf === undefined) {
    return (position, _option, label, current) =>
      cell(
        label,
        Style.combine([
          bandItemStyle(active, { ...position, distribution }, drawnAt),
          currentMark(current),
        ]),
      );
  }
  const text = stateCell(active.palette, ground, drawnAt);
  return (_position, option, label, current) =>
    named(
      label,
      Style.combine([text, currentMark(current)]),
      paletteOf(option, render),
    );
}

// [LAW:one-source-of-truth] A colour-valued name as the bar shows it: the
// name in `text`, then a space of the same, then the swatch.
const named = (label: string, text: Style | undefined, palette: Palette) =>
  cell(
    RichText.fromFragments([
      cell(label, text),
      cell(" ", text),
      swatch(palette),
    ]),
  );

/**
 * The paint of a control's own label — a `{{ carousel }}`'s: the text in the
 * segment's own colours, as the arrows beside it are, and, when the domain is
 * colour-valued, the swatch of `option` beside it.
 */
export function valuePaint(
  render: RenderPalettes,
  paletteOf: OptionPalette | undefined,
): ItemPaint {
  if (paletteOf === undefined)
    return (_position, _option, label) => cell(label);
  return (_position, option, label) =>
    named(label, undefined, paletteOf(option, render));
}

/**
 * The paint of a `{{ swatches }}` row: each option is its swatch alone, on
 * `ground`, the one in force set between brackets — "the currently selected
 * theme is marked in some way" — and every other between spaces of the same
 * width, so marking a swatch moves none of them and no page boundary shifts
 * when the pick does.
 */
export function swatchPaint(
  active: ActiveSegment,
  render: RenderPalettes,
  paletteOf: OptionPalette,
  drawnAt: ColorDepth,
  ground: ColorRgba,
): ItemPaint {
  const text = stateCell(active.palette, ground, drawnAt);
  return (_position, option, _label, current) =>
    cell(
      RichText.fromFragments([
        cell(current ? "[" : " ", text),
        swatch(paletteOf(option, render)),
        cell(current ? "]" : " ", text),
      ]),
    );
}
