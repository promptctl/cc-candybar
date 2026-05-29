// [LAW:single-enforcer] Public barrel for the themes module. Name/string policy
// lives in policy.ts; the only color math cc-candybar keeps (OKLCH hue rotation)
// lives in oklch.ts. rich-js owns palettes, hydration, and the anchor rule.
export {
  resolvePaletteName,
  listResolvablePaletteNames,
  listAvailableThemes,
  pickRandomTheme,
  STYLE_ORDER,
  DISPLAY_STYLES,
} from "./policy.js";

export { rotateHue } from "./oklch.js";
