/**
 * Default semantic mapping from segment names to Textual palette variables.
 *
 * All segments use `primary` as the bg base variable with OKLCH hue rotation
 * for visual variety. The `hue` field specifies the rotation offset in degrees.
 *
 * `contextWarning` and `contextCritical` use `warning`/`error` directly —
 * these are semantically fixed colors (yellow/red) that must not rotate.
 */

export interface SegmentColors {
  bg: string;
  fg: string;
  /** OKLCH hue rotation offset in degrees. 0 = no rotation. */
  hue?: number;
}

export type PaletteMapping = Record<string, SegmentColors>;

export const semanticMapping: PaletteMapping = {
  directory:       { bg: "primary", fg: "foreground",  hue: 0 },
  git:             { bg: "primary", fg: "foreground",  hue: 25 },
  gitTaculous:     { bg: "primary", fg: "foreground",  hue: 25 },
  model:           { bg: "primary", fg: "foreground",  hue: 50 },
  session:         { bg: "primary", fg: "foreground",  hue: 75 },
  block:           { bg: "primary", fg: "foreground",  hue: 100 },
  today:           { bg: "primary", fg: "foreground",  hue: 125 },
  tmux:            { bg: "primary", fg: "foreground",  hue: 150 },
  context:         { bg: "primary", fg: "foreground",  hue: 175 },
  contextWarning:  { bg: "warning", fg: "foreground" },
  contextCritical: { bg: "error",   fg: "foreground" },
  metrics:         { bg: "primary", fg: "foreground",  hue: 200 },
  version:         { bg: "primary", fg: "foreground",  hue: 225 },
  env:             { bg: "primary", fg: "foreground",  hue: 250 },
  weekly:          { bg: "primary", fg: "foreground",  hue: 275 },
  toolbar:         { bg: "primary", fg: "foreground",  hue: 300 },
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
