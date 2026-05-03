// Re-export cascade as the public API
export {
  resolveThemeColors,
  listAvailableThemes,
  resolvePaletteName,
} from "./cascade.js";
export type { CascadeConfig } from "./cascade.js";

// Re-export mapping types for external use
export type { SegmentColors, PaletteMapping } from "./default-mapping.js";
export { semanticMapping, mappingFromHueStep } from "./default-mapping.js";

// Re-export OKLCH utilities
export { rotateHue } from "./oklch.js";

// --- Backward-compat types (consumers still reference these) ---

export interface SegmentColor {
  bg: string;
  fg: string;
}

export interface ColorTheme {
  directory: SegmentColor;
  git: SegmentColor;
  model: SegmentColor;
  session: SegmentColor;
  block: SegmentColor;
  today: SegmentColor;
  tmux: SegmentColor;
  context: SegmentColor;
  contextWarning: SegmentColor;
  contextCritical: SegmentColor;
  metrics: SegmentColor;
  version: SegmentColor;
  env: SegmentColor;
  weekly: SegmentColor;
}

export interface PowerlineHexColors {
  modeBg: string;
  modeFg: string;
  gitBg: string;
  gitFg: string;
  modelBg: string;
  modelFg: string;
  sessionBg: string;
  sessionFg: string;
  blockBg: string;
  blockFg: string;
  todayBg: string;
  todayFg: string;
  tmuxBg: string;
  tmuxFg: string;
  contextBg: string;
  contextFg: string;
  contextWarningBg: string;
  contextWarningFg: string;
  contextCriticalBg: string;
  contextCriticalFg: string;
  metricsBg: string;
  metricsFg: string;
  versionBg: string;
  versionFg: string;
  envBg: string;
  envFg: string;
  weeklyBg: string;
  weeklyFg: string;
  partFg: Record<string, string>;
}

export interface PowerlineColors {
  reset: string;
  modeBg: string;
  modeFg: string;
  gitBg: string;
  gitFg: string;
  modelBg: string;
  modelFg: string;
  sessionBg: string;
  sessionFg: string;
  blockBg: string;
  blockFg: string;
  todayBg: string;
  todayFg: string;
  tmuxBg: string;
  tmuxFg: string;
  contextBg: string;
  contextFg: string;
  contextWarningBg: string;
  contextWarningFg: string;
  contextCriticalBg: string;
  contextCriticalFg: string;
  metricsBg: string;
  metricsFg: string;
  versionBg: string;
  versionFg: string;
  envBg: string;
  envFg: string;
  weeklyBg: string;
  weeklyFg: string;
  partFg: Record<string, string>;
  hex?: PowerlineHexColors;
}
