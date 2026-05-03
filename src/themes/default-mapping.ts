/**
 * Default semantic mapping from segment names to Textual palette variables.
 *
 * Each segment gets specific bg/fg palette variables — no hue rotation.
 * Variety comes from the palette variables themselves, not runtime rotation.
 */

export interface SegmentColors {
  bg: string;
  fg: string;
}

export type PaletteMapping = Record<string, SegmentColors>;

export const semanticMapping: PaletteMapping = {
  directory:       { bg: "primary",   fg: "button-color-foreground" },
  git:             { bg: "secondary", fg: "button-color-foreground" },
  gitTaculous:     { bg: "secondary", fg: "button-color-foreground" },
  model:           { bg: "accent",    fg: "button-color-foreground" },
  session:         { bg: "success",   fg: "button-color-foreground" },
  block:           { bg: "boost",     fg: "button-color-foreground" },
  today:           { bg: "primary",   fg: "button-color-foreground" },
  tmux:            { bg: "secondary", fg: "button-color-foreground" },
  context:         { bg: "panel",     fg: "foreground" },
  contextWarning:  { bg: "warning",   fg: "button-color-foreground" },
  contextCritical: { bg: "error",     fg: "button-color-foreground" },
  metrics:         { bg: "accent",    fg: "button-color-foreground" },
  version:         { bg: "success",   fg: "button-color-foreground" },
  env:             { bg: "panel",     fg: "foreground" },
  weekly:          { bg: "boost",     fg: "button-color-foreground" },
  toolbar:         { bg: "primary",   fg: "button-color-foreground" },
};
