/**
 * Default mapping from segment names to Textual palette variables.
 *
 * All segments use the same base (primary bg, foreground fg).
 * Variety comes from hueStep at resolution time, which rotates
 * the base color by position — not from hardcoded per-segment offsets.
 *
 * contextWarning and contextCritical use warning/error directly —
 * these are semantically fixed colors that must not rotate.
 */

export interface SegmentColors {
  bg: string;
  fg: string;
  hue?: number;
}

export type PaletteMapping = Record<string, SegmentColors>;

export const semanticMapping: PaletteMapping = {
  directory:       { bg: "primary", fg: "foreground" },
  git:             { bg: "primary", fg: "foreground" },
  gitTaculous:     { bg: "primary", fg: "foreground" },
  model:           { bg: "primary", fg: "foreground" },
  session:         { bg: "primary", fg: "foreground" },
  block:           { bg: "primary", fg: "foreground" },
  today:           { bg: "primary", fg: "foreground" },
  tmux:            { bg: "primary", fg: "foreground" },
  context:         { bg: "primary", fg: "foreground" },
  contextWarning:  { bg: "warning", fg: "foreground" },
  contextCritical: { bg: "error",   fg: "foreground" },
  metrics:         { bg: "primary", fg: "foreground" },
  version:         { bg: "primary", fg: "foreground" },
  env:             { bg: "primary", fg: "foreground" },
  weekly:          { bg: "primary", fg: "foreground" },
  toolbar:         { bg: "primary", fg: "foreground" },
};

/**
 * Segment names in canonical order — used by hueStep to assign
 * auto-incremented offsets.
 */
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
 * Build a mapping with auto-incremented hue offsets from a step value.
 * contextWarning and contextCritical keep their non-rotated warning/error vars.
 */
export function mappingFromHueStep(step: number): PaletteMapping {
  const result: PaletteMapping = {};
  let hueIndex = 0;
  for (const name of SEGMENT_ORDER) {
    if (name === "contextWarning") {
      result[name] = { bg: "warning", fg: "foreground" };
    } else if (name === "contextCritical") {
      result[name] = { bg: "error", fg: "foreground" };
    } else {
      result[name] = { bg: "primary", fg: "foreground", hue: hueIndex * step };
      hueIndex++;
    }
  }
  return result;
}
