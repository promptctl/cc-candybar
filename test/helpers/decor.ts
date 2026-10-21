// The decor a test renders the closed bar under, by name — the values the
// render itself resolves a selection's names to (render.ts `drawDsl`'s decor).
import { floorOf } from "../../src/config/globals-fields";
import {
  SHADES,
  VARIATIONS,
  type Decor,
  type ShadeName,
  type VariationName,
} from "../../src/themes/decor";

export const decorOf = (
  variation: VariationName = floorOf("variation"),
  shade: ShadeName = floorOf("shade"),
): Decor => ({ variation: VARIATIONS[variation], shade: SHADES[shade] });

/** The decor a bar wears when nothing picks one: the defaults of both settings. */
export const DEFAULT_DECOR: Decor = decorOf();
