// [LAW:single-enforcer] Public barrel for the themes module. Name/string policy
// lives in policy.ts; memoized resolver construction (name→resolver and
// transposition) lives in palette-resolvers.ts. rich-js owns palettes,
// hydration, all color math, and the anchor rule — cc-candybar keeps no color
// arithmetic of its own.
export {
  resolvePaletteName,
  effectiveThemeName,
  effectiveLookName,
  lookKeyByName,
  effectiveStripStyle,
  isStripStyle,
  listResolvablePaletteNames,
  STRIP_STYLES,
} from "./policy.js";
export type { StripStyle } from "./policy.js";

export {
  resolverForThemeName,
  transposedResolver,
} from "./palette-resolvers.js";
