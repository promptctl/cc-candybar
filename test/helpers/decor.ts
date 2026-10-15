// The decor a test renders the closed bar under, by name — the values the
// render itself resolves a selection's names to (render.ts `declaredDecor`).
import { DEFAULT_SHADE, DEFAULT_VARIATION } from "../../src/themes/policy";
import {
  SHADES,
  VARIATIONS,
  type Decor,
  type ShadeName,
  type VariationName,
} from "../../src/themes/decor";

export const decorOf = (
  variation: VariationName = DEFAULT_VARIATION,
  shade: ShadeName = DEFAULT_SHADE,
): Decor => ({ variation: VARIATIONS[variation], shade: SHADES[shade] });

/** The decor a bar wears when nothing picks one: the defaults of both settings. */
export const DEFAULT_DECOR: Decor = decorOf();
