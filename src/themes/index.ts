// [LAW:single-enforcer] rich-js owns every colour operation, not this module.
export {
  resolvePaletteName,
  effectiveThemeName,
  effectiveLookName,
  lookKeyByName,
  effectiveStripStyle,
  effectiveAutoWrap,
  effectivePadding,
  isStripStyle,
  listResolvablePaletteNames,
  STRIP_STYLES,
} from "./policy.js";
export type { StripStyle } from "./policy.js";

export { paletteForThemeName, transposedPalette } from "./palette-resolvers.js";

export {
  DECOR_HUES,
  DECOR_BASES,
  DECOR_AMTS,
  DECOR_VOCABULARY,
  DISTRIBUTIONS,
  DISTRIBUTION_NAMES,
  DEFAULT_DISTRIBUTION,
  placedBy,
  vocabularySelect,
  decorEntryFor,
  paletteRole,
  decorFor,
} from "./decor.js";
export type {
  DecorHue,
  DecorBase,
  DecorAmount,
  DecorEntry,
  SemanticRole,
  Distribution,
  DistributionName,
  Position,
  AddressStep,
  Address,
} from "./decor.js";
