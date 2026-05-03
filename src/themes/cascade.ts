import {
  Palette,
  PaletteResolver,
  type ColorRgba,
} from "rich-js";
import { getThemePalette, listThemePalettes } from "./palette-registry.js";
import {
  hexToAnsi,
  hexTo256Ansi,
  hexToBasicAnsi,
  hexColorDistance,
} from "../utils/colors";
import { RESET_CODE } from "../utils/constants";
import { rotateHue } from "./oklch.js";
import {
  semanticMapping,
  mappingFromHueStep,
  type PaletteMapping,
  type SegmentColors,
} from "./default-mapping.js";
import type { PowerlineColors, PowerlineHexColors, ColorTheme } from "./index";

// --- Theme name aliasing ---

const THEME_ALIASES: Record<string, string> = {
  dark: "textual-dark",
  light: "textual-light",
};

function resolvePaletteName(name: string): string {
  return THEME_ALIASES[name] ?? name;
}

// --- ColorRgba → hex string ---

function colorToHex(c: ColorRgba): string {
  const r = c.red.toString(16).padStart(2, "0");
  const g = c.green.toString(16).padStart(2, "0");
  const b = c.blue.toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

// --- Merge user overrides into mapping ---

export interface SegmentOverride {
  bg?: string;
  fg?: string;
  hue?: number;
  palette?: string;
}

function mergeOverrides(
  base: PaletteMapping,
  overrides: Record<string, SegmentOverride> | undefined,
): PaletteMapping {
  if (!overrides) return base;
  const merged: PaletteMapping = { ...base };
  for (const [seg, ov] of Object.entries(overrides)) {
    if (!ov) continue;
    const existing = merged[seg] ?? { bg: "primary", fg: "auto" };
    merged[seg] = {
      bg: ov.bg ?? existing.bg,
      fg: ov.fg ?? existing.fg,
      hue: ov.hue ?? existing.hue,
    };
    // [LAW:locality-or-seam] Per-segment palette pull is stored as a special
    // marker — the cascade resolver reads it when resolving that segment.
    if (ov.palette) {
      (merged[seg] as SegmentColors & { _palette?: string })._palette =
        ov.palette;
    }
  }
  return merged;
}

// --- Resolve all segment colors ---

interface ResolvedSegment {
  bgHex: string;
  fgHex: string;
}

function resolveSegment(
  spec: SegmentColors & { _palette?: string },
  mainPalette: Palette,
): ResolvedSegment | null {
  const palette =
    spec._palette != null
      ? (getThemePalette(resolvePaletteName(spec._palette)) ?? mainPalette)
      : mainPalette;

  const resolver = new PaletteResolver(palette);

  // [LAW:dataflow-not-control-flow] Resolve bg first, then fg with
  // against=resolvedBg — same code path every time, the spec and context
  // decide the output, not branching.
  const bgRgba = resolver.resolve(spec.bg);
  if (!bgRgba) return null;

  const applyHue = (c: ColorRgba): ColorRgba =>
    spec.hue != null && spec.hue !== 0 ? rotateHue(c, spec.hue) : c;

  const rotatedBg = applyHue(bgRgba);

  const bgCtx = { against: rotatedBg };
  const fgRgba = resolver.resolve(spec.fg, bgCtx);
  if (!fgRgba) return null;

  const rotatedFg = applyHue(fgRgba);

  return {
    bgHex: colorToHex(rotatedBg),
    fgHex: colorToHex(rotatedFg),
  };
}

// --- Custom theme backward compat ---

function customThemeToOverrides(
  custom: ColorTheme,
): Record<string, SegmentOverride> {
  const overrides: Record<string, SegmentOverride> = {};
  for (const [seg, colors] of Object.entries(custom)) {
    if (!colors) continue;
    const c = colors as { bg?: string; fg?: string };
    overrides[seg] = { bg: c.bg, fg: c.fg, hue: 0 };
  }
  return overrides;
}

// --- Main entry point ---

export interface CascadeConfig {
  theme: string;
  themeMapping?: Record<string, SegmentOverride>;
  hueStep?: number;
  customColors?: ColorTheme;
  colorSupport: "none" | "ansi" | "ansi256" | "truecolor";
  isTui?: boolean;
  isLightTheme?: boolean;
}

export function resolveThemeColors(config: CascadeConfig): PowerlineColors {
  const paletteName = resolvePaletteName(config.theme);
  const palette = getThemePalette(paletteName);
  if (!palette) {
    throw new Error(`Unknown theme palette: "${config.theme}"`);
  }

  // Select mapping: hueStep generates one, otherwise use semantic default
  let mapping: PaletteMapping =
    config.hueStep != null
      ? mappingFromHueStep(config.hueStep)
      : semanticMapping;

  // Merge custom theme colors (backward compat with colors.custom)
  if (config.customColors) {
    mapping = mergeOverrides(mapping, customThemeToOverrides(config.customColors));
  }

  // Merge user overrides (highest priority)
  mapping = mergeOverrides(mapping, config.themeMapping);

  // Resolve each segment
  const resolved = new Map<string, ResolvedSegment>();
  for (const [segName, spec] of Object.entries(mapping)) {
    const r = resolveSegment(spec, palette);
    if (r) resolved.set(segName, r);
  }

  // Build PowerlineColors
  const convertHex = (hex: string, isBg: boolean): string => {
    if (config.colorSupport === "none") return "";
    if (config.colorSupport === "ansi") return hexToBasicAnsi(hex, isBg);
    if (config.colorSupport === "ansi256") return hexTo256Ansi(hex, isBg);
    return hexToAnsi(hex, isBg);
  };

  const get = (seg: string): ResolvedSegment => {
    const r = resolved.get(seg);
    if (!r) {
      // [LAW:dataflow-not-control-flow] Fallback is a resolved default,
      // not a special case — every segment flows through the same path.
      const fallback = resolved.get("directory");
      return fallback ?? { bgHex: "#000000", fgHex: "#ffffff" };
    }
    return r;
  };

  const isTui = config.isTui ?? false;
  const terminalRef =
    config.isLightTheme ?? palette.dark === false ? "#f0f0f0" : "#1e1e1e";

  const dir = get("directory");
  const git = get("git");
  const model = get("model");
  const session = get("session");
  const block = get("block");
  const today = get("today");
  const tmux = get("tmux");
  const context = get("context");
  const contextWarning = get("contextWarning");
  const contextCritical = get("contextCritical");
  const metrics = get("metrics");
  const version = get("version");
  const env = get("env");
  const weekly = get("weekly");

  const tuiFgFix = (seg: ResolvedSegment): { fgHex: string } => {
    if (isTui && hexColorDistance(seg.fgHex, terminalRef) < 60) {
      return { fgHex: seg.bgHex };
    }
    return { fgHex: seg.fgHex };
  };

  const dirFg = tuiFgFix(dir);
  const gitFg = tuiFgFix(git);
  const modelFg = tuiFgFix(model);
  const sessionFg = tuiFgFix(session);
  const blockFg = tuiFgFix(block);
  const todayFg = tuiFgFix(today);
  const tmuxFg = tuiFgFix(tmux);
  const contextFg = tuiFgFix(context);
  const contextWarningFg = tuiFgFix(contextWarning);
  const contextCriticalFg = tuiFgFix(contextCritical);
  const metricsFg = tuiFgFix(metrics);
  const versionFg = tuiFgFix(version);
  const envFg = tuiFgFix(env);
  const weeklyFg = tuiFgFix(weekly);

  const hex: PowerlineHexColors = {
    modeBg: dir.bgHex,
    modeFg: dirFg.fgHex,
    gitBg: git.bgHex,
    gitFg: gitFg.fgHex,
    modelBg: model.bgHex,
    modelFg: modelFg.fgHex,
    sessionBg: session.bgHex,
    sessionFg: sessionFg.fgHex,
    blockBg: block.bgHex,
    blockFg: blockFg.fgHex,
    todayBg: today.bgHex,
    todayFg: todayFg.fgHex,
    tmuxBg: tmux.bgHex,
    tmuxFg: tmuxFg.fgHex,
    contextBg: context.bgHex,
    contextFg: contextFg.fgHex,
    contextWarningBg: contextWarning.bgHex,
    contextWarningFg: contextWarningFg.fgHex,
    contextCriticalBg: contextCritical.bgHex,
    contextCriticalFg: contextCriticalFg.fgHex,
    metricsBg: metrics.bgHex,
    metricsFg: metricsFg.fgHex,
    versionBg: version.bgHex,
    versionFg: versionFg.fgHex,
    envBg: env.bgHex,
    envFg: envFg.fgHex,
    weeklyBg: weekly.bgHex,
    weeklyFg: weeklyFg.fgHex,
    partFg: {},
  };

  return {
    reset: config.colorSupport === "none" ? "" : RESET_CODE,
    modeBg: convertHex(dir.bgHex, true),
    modeFg: convertHex(dirFg.fgHex, false),
    gitBg: convertHex(git.bgHex, true),
    gitFg: convertHex(gitFg.fgHex, false),
    modelBg: convertHex(model.bgHex, true),
    modelFg: convertHex(modelFg.fgHex, false),
    sessionBg: convertHex(session.bgHex, true),
    sessionFg: convertHex(sessionFg.fgHex, false),
    blockBg: convertHex(block.bgHex, true),
    blockFg: convertHex(blockFg.fgHex, false),
    todayBg: convertHex(today.bgHex, true),
    todayFg: convertHex(todayFg.fgHex, false),
    tmuxBg: convertHex(tmux.bgHex, true),
    tmuxFg: convertHex(tmuxFg.fgHex, false),
    contextBg: convertHex(context.bgHex, true),
    contextFg: convertHex(contextFg.fgHex, false),
    contextWarningBg: convertHex(contextWarning.bgHex, true),
    contextWarningFg: convertHex(contextWarningFg.fgHex, false),
    contextCriticalBg: convertHex(contextCritical.bgHex, true),
    contextCriticalFg: convertHex(contextCriticalFg.fgHex, false),
    metricsBg: convertHex(metrics.bgHex, true),
    metricsFg: convertHex(metricsFg.fgHex, false),
    versionBg: convertHex(version.bgHex, true),
    versionFg: convertHex(versionFg.fgHex, false),
    envBg: convertHex(env.bgHex, true),
    envFg: convertHex(envFg.fgHex, false),
    weeklyBg: convertHex(weekly.bgHex, true),
    weeklyFg: convertHex(weeklyFg.fgHex, false),
    partFg: {},
    hex,
  };
}

/**
 * List all available theme names (aliases + registry names).
 */
export function listAvailableThemes(): string[] {
  const registryNames = listThemePalettes();
  const allNames = new Set<string>(registryNames as readonly string[]);
  for (const alias of Object.keys(THEME_ALIASES)) {
    allNames.add(alias);
  }
  allNames.add("custom");
  return [...allNames].sort();
}

export { resolvePaletteName };
