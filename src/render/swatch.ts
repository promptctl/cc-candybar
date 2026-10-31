// [LAW:one-source-of-truth] A theme's SWATCH — the few cells that stand for a
// theme wherever the bar names one (brandon-theme-swatch-8v9r). Brandon: "The
// name loses its styling and the swatch carries the colour." So a name is
// written in the text around it, and the swatch beside it is the only thing
// drawn in the theme being named.
//
// What it shows is what tells two themes apart on a bar: the decorative roles
// every closed cell is dealt from (`DECOR_HUES`, the roles the variations step
// through) and the ground the theme draws them on. Each cell is an upper half
// block, the role on top and the theme's `background` beneath it, so a light
// theme and a dark one over similar hues still read apart. The roles are the
// palette's own, as it names them: a swatch identifies a theme, so it does not
// move with the look (variation, shade) the bar happens to wear.
//
// [LAW:one-way-deps] Pure: a palette in, cells out. Callers lay links over it.

import { ColorSpec, RichText, Style } from "@promptctl/rich-js";
import type { Palette } from "@promptctl/rich-js";
import { DECOR_HUES } from "../themes/decor.js";

export const SWATCH_GLYPH = "▀";

/** The cells of `palette`'s swatch, in DECOR_HUES order. */
export function swatch(palette: Palette): RichText {
  const ground = ColorSpec.fromRgba(palette.get("background"));
  const drawn = RichText.fromFragments(
    DECOR_HUES.map(
      (role) =>
        new RichText(SWATCH_GLYPH, {
          style: new Style({
            color: ColorSpec.fromRgba(palette.get(role)),
            bgcolor: ground,
          }),
        }),
    ),
  );
  drawn.overflow = "ignore";
  drawn.end = "";
  return drawn;
}
