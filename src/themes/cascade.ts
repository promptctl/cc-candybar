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
} from "../utils/colors";
import { RESET_CODE } from "../utils/constants";
import { rotateHue } from "./oklch.js";
import {
  buildPaletteMapping,
  DEFAULT_STYLE,
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
  style?: string;
  themeMapping?: Record<string, SegmentOverride>;
  hueStep?: number;
  customColors?: ColorTheme;
  colorSupport: "none" | "ansi" | "ansi256" | "truecolor";
}

export function resolveThemeColors(config: CascadeConfig): PowerlineColors {
  const paletteName = resolvePaletteName(config.theme);
  const palette = getThemePalette(paletteName);
  if (!palette) {
    throw new Error(`Unknown theme palette: "${config.theme}"`);
  }

  // Build mapping from style preset + optional hue rotation
  let mapping = buildPaletteMapping(
    config.style ?? DEFAULT_STYLE,
    config.hueStep,
  );

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

  const hex: PowerlineHexColors = {
    modeBg: dir.bgHex,
    modeFg: dir.fgHex,
    gitBg: git.bgHex,
    gitFg: git.fgHex,
    modelBg: model.bgHex,
    modelFg: model.fgHex,
    sessionBg: session.bgHex,
    sessionFg: session.fgHex,
    blockBg: block.bgHex,
    blockFg: block.fgHex,
    todayBg: today.bgHex,
    todayFg: today.fgHex,
    tmuxBg: tmux.bgHex,
    tmuxFg: tmux.fgHex,
    contextBg: context.bgHex,
    contextFg: context.fgHex,
    contextWarningBg: contextWarning.bgHex,
    contextWarningFg: contextWarning.fgHex,
    contextCriticalBg: contextCritical.bgHex,
    contextCriticalFg: contextCritical.fgHex,
    metricsBg: metrics.bgHex,
    metricsFg: metrics.fgHex,
    versionBg: version.bgHex,
    versionFg: version.fgHex,
    envBg: env.bgHex,
    envFg: env.fgHex,
    weeklyBg: weekly.bgHex,
    weeklyFg: weekly.fgHex,
    partFg: {},
  };

  return {
    reset: config.colorSupport === "none" ? "" : RESET_CODE,
    modeBg: convertHex(dir.bgHex, true),
    modeFg: convertHex(dir.fgHex, false),
    gitBg: convertHex(git.bgHex, true),
    gitFg: convertHex(git.fgHex, false),
    modelBg: convertHex(model.bgHex, true),
    modelFg: convertHex(model.fgHex, false),
    sessionBg: convertHex(session.bgHex, true),
    sessionFg: convertHex(session.fgHex, false),
    blockBg: convertHex(block.bgHex, true),
    blockFg: convertHex(block.fgHex, false),
    todayBg: convertHex(today.bgHex, true),
    todayFg: convertHex(today.fgHex, false),
    tmuxBg: convertHex(tmux.bgHex, true),
    tmuxFg: convertHex(tmux.fgHex, false),
    contextBg: convertHex(context.bgHex, true),
    contextFg: convertHex(context.fgHex, false),
    contextWarningBg: convertHex(contextWarning.bgHex, true),
    contextWarningFg: convertHex(contextWarning.fgHex, false),
    contextCriticalBg: convertHex(contextCritical.bgHex, true),
    contextCriticalFg: convertHex(contextCritical.fgHex, false),
    metricsBg: convertHex(metrics.bgHex, true),
    metricsFg: convertHex(metrics.fgHex, false),
    versionBg: convertHex(version.bgHex, true),
    versionFg: convertHex(version.fgHex, false),
    envBg: convertHex(env.bgHex, true),
    envFg: convertHex(env.fgHex, false),
    weeklyBg: convertHex(weekly.bgHex, true),
    weeklyFg: convertHex(weekly.fgHex, false),
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
  allNames.add("custom");
  return [...allNames].sort();
}

export { resolvePaletteName };
