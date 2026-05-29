// [LAW:single-enforcer] Public barrel for the themes module. Name/string policy
// lives in policy.ts; per-segment palette transposition lives in
// transposed-resolver.ts. rich-js owns palettes, hydration, all color math, and
// the anchor rule — cc-candybar keeps no color arithmetic of its own.
export {
  resolvePaletteName,
  effectiveThemeName,
  listResolvablePaletteNames,
  listAvailableThemes,
  pickRandomTheme,
  STYLE_ORDER,
  DISPLAY_STYLES,
} from "./policy.js";

export {
  resolverForThemeName,
  transposedResolver,
} from "./palette-resolvers.js";
