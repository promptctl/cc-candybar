/**
 * Browser-safe entry point for cc-candybar.
 *
 * Exports all rendering modules, themes, types, and utilities needed
 * to generate statusline output without any Node.js built-in modules.
 *
 * Data providers (git, session, metrics, etc.) are NOT exported here —
 * supply pre-built data objects to the rendering functions instead.
 */

// --- Types ---

export type { ClaudeHookData } from "./utils/claude";

export type {
  PowerlineConfig,
  DisplayConfig,
  LineConfig,
  BudgetConfig,
  BudgetItemConfig,
} from "./config/loader";

export type { ColorTheme, PowerlineColors, SegmentColor } from "./themes";

export type { GitInfo } from "./segments/git";
export type {
  UsageInfo,
  SessionInfo,
  TokenBreakdown,
} from "./segments/session";
export type { ContextInfo } from "./segments/context";
export type { MetricsInfo } from "./segments/metrics";
export type { BlockInfo } from "./segments/block";
export type { TodayInfo } from "./segments/today";

export type {
  SegmentConfig,
  AnySegmentConfig,
  DirectorySegmentConfig,
  GitSegmentConfig,
  UsageSegmentConfig,
  ContextSegmentConfig,
  MetricsSegmentConfig,
  BlockSegmentConfig,
  TodaySegmentConfig,
  VersionSegmentConfig,
  SessionIdSegmentConfig,
  EnvSegmentConfig,
  WeeklySegmentConfig,
  PowerlineSymbols,
  SegmentData,
  BarDisplayStyle,
} from "./segments/renderer";

// --- Rendering ---

export { SegmentRenderer } from "./segments/renderer";

// --- Themes ---

export {
  resolveThemeColors,
  listAvailableThemes,
  buildPaletteMapping,
  STYLE_ORDER,
  STYLE_PRESETS,
  DEFAULT_STYLE,
  SEMANTIC_VARIANTS,
  rotateHue,
} from "./themes";
export type {
  CascadeConfig,
  SegmentColors,
  PaletteMapping,
  StylePreset,
  SemanticVariant,
} from "./themes";

// --- Constants ---

export { SYMBOLS, TEXT_SYMBOLS, RESET_CODE } from "./utils/constants";

// --- Pure utilities ---

export {
  hexToAnsi,
  extractBgToFg,
  hexTo256Ansi,
  hexToBasicAnsi,
  hexColorDistance,
} from "./utils/colors";
export { stripAnsi, visibleLength, ESC } from "./utils/terminal";
export {
  formatCost,
  formatTokens,
  formatTokenBreakdown,
  formatTimeSince,
  formatDuration,
  formatModelName,
  abbreviateFishStyle,
  formatResponseTime,
  formatTokenCount,
  formatBurnRate,
  collapseHome,
  formatTimeRemaining,
  formatLongTimeRemaining,
  minutesUntilReset,
} from "./utils/formatters";
export { getBudgetStatus } from "./utils/budget";

// --- Config defaults ---

export { DEFAULT_CONFIG } from "./config/defaults";
