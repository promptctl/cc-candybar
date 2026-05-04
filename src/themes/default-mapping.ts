/**
 * Semantic variant assignments and style presets.
 *
 * Each segment maps to a semantic variant (primary, secondary, accent, etc.).
 * A style preset transforms variants into actual palette variable names:
 *   muted:  `${variant}-muted` / `text-${variant}`
 *   surface: surface-bg map / `foreground`
 *   button: `${variant}` / `button-color-foreground`
 *   hue:    `${variant}` / `foreground`  (variety from OKLCH hue rotation)
 *
 * contextWarning and contextCritical always use raw warning/error —
 * these are semantically fixed colors that must not transform.
 */

export type SemanticVariant =
  | "primary"
  | "secondary"
  | "accent"
  | "success"
  | "warning"
  | "error";

export interface SegmentColors {
  bg: string;
  fg: string;
  hue?: number;
}

export type PaletteMapping = Record<string, SegmentColors>;

/**
 * Variant assignment per segment — determines each segment's semantic role.
 * Segments that share a variant get the same base color; style provides variety.
 */
export const SEMANTIC_VARIANTS: Record<string, SemanticVariant> = {
  directory:       "primary",
  git:             "secondary",
  gitTaculous:     "secondary",
  model:           "accent",
  session:         "success",
  block:           "error",
  today:           "primary",
  tmux:            "secondary",
  context:         "warning",
  contextWarning:  "warning",
  contextCritical: "error",
  metrics:         "accent",
  version:         "success",
  env:             "warning",
  weekly:          "error",
  toolbar:         "primary",
};

/** Segments with fixed semantic colors — no style transform, no hue rotation. */
const SEMANTIC_SEGMENTS = new Set(["contextWarning", "contextCritical"]);

// --- Style presets ---

const SURFACE_BG: Record<SemanticVariant, string> = {
  primary:   "surface",
  secondary: "surface-active",
  accent:    "panel",
  success:   "surface",
  warning:   "surface-active",
  error:     "panel",
};

export interface StylePreset {
  name: string;
  resolve(variant: SemanticVariant): SegmentColors;
}

export const STYLE_PRESETS: Record<string, StylePreset> = {
  surface: {
    name: "Surface",
    resolve: (v) => ({ bg: SURFACE_BG[v], fg: "foreground" }),
  },
  muted: {
    name: "Muted + Text",
    resolve: (v) => ({ bg: `${v}-muted`, fg: `text-${v}` }),
  },
  button: {
    name: "Button",
    resolve: (v) => ({ bg: v, fg: "button-color-foreground" }),
  },
  hue: {
    name: "Hue Rotation",
    resolve: (v) => ({ bg: v, fg: "foreground" }),
  },
};

export const STYLE_ORDER: readonly string[] = [
  "surface",
  "muted",
  "button",
  "hue",
];

export const DEFAULT_STYLE = "surface";

// --- Segment order (for hue rotation indexing) ---

export const SEGMENT_ORDER: readonly string[] = [
  "directory",
  "git",
  "gitTaculous",
  "model",
  "session",
  "block",
  "today",
  "tmux",
  "context",
  "contextWarning",
  "contextCritical",
  "metrics",
  "version",
  "env",
  "weekly",
  "toolbar",
];

/**
 * Build a PaletteMapping from a style preset + optional hue rotation.
 * Semantic segments (contextWarning, contextCritical) always use raw
 * warning/error with button-color-foreground, bypassing style and hue.
 */
export function buildPaletteMapping(
  style: string,
  hueStep?: number,
): PaletteMapping {
  const preset = STYLE_PRESETS[style] ?? STYLE_PRESETS["surface"]!;
  const mapping: PaletteMapping = {};
  let hueIndex = 0;

  for (const seg of SEGMENT_ORDER) {
    const variant = SEMANTIC_VARIANTS[seg] ?? "primary";
    const isSemantic = SEMANTIC_SEGMENTS.has(seg);

    const base: SegmentColors = isSemantic
      ? { bg: variant, fg: "button-color-foreground" }
      : preset.resolve(variant);

    const applyHue = !isSemantic && hueStep;
    const hue = applyHue ? hueIndex * hueStep : undefined;
    if (applyHue) hueIndex++;

    mapping[seg] = hue != null ? { ...base, hue } : base;
  }

  return mapping;
}
