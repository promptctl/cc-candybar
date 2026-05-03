import process from "node:process";
import {
  resolveThemeColors,
  listAvailableThemes,
  type SegmentColors,
} from "../themes/index.js";
import { getThemePalette } from "../themes/palette-registry.js";
import type { PowerlineHexColors } from "../themes/index.js";
import {
  buildFlexStripLines,
  type StripStyle,
} from "../render/strip.js";
import { MOCK_SAMPLES, type MockSegment } from "./mock-data.js";
import type { ColorRgba } from "rich-js";
import type { SegmentOverride } from "../themes/cascade.js";

// --- Segment type → PowerlineHexColors key mapping ---

type HexColorKey = Exclude<keyof PowerlineHexColors, "partFg">;

const SEGMENT_COLOR_KEYS: Record<
  string,
  { bg: HexColorKey; fg: HexColorKey }
> = {
  directory: { bg: "modeBg", fg: "modeFg" },
  git: { bg: "gitBg", fg: "gitFg" },
  gitTaculous: { bg: "gitBg", fg: "gitFg" },
  model: { bg: "modelBg", fg: "modelFg" },
  session: { bg: "sessionBg", fg: "sessionFg" },
  context: { bg: "contextBg", fg: "contextFg" },
  contextWarning: { bg: "contextWarningBg", fg: "contextWarningFg" },
  contextCritical: { bg: "contextCriticalBg", fg: "contextCriticalFg" },
  block: { bg: "blockBg", fg: "blockFg" },
  today: { bg: "todayBg", fg: "todayFg" },
  tmux: { bg: "tmuxBg", fg: "tmuxFg" },
  metrics: { bg: "metricsBg", fg: "metricsFg" },
  version: { bg: "versionBg", fg: "versionFg" },
  env: { bg: "envBg", fg: "envFg" },
  weekly: { bg: "weeklyBg", fg: "weeklyFg" },
};

// --- Mapping presets ---
// Each preset specifies BOTH fg and bg independently per segment.
// Textual pattern: core colors → button-color-foreground, muted → text-*, surfaces → foreground.

type MappingPreset = {
  name: string;
  // null = use semanticMapping defaults. Non-null = override passed to cascade.
  overrides: Record<string, SegmentOverride> | null;
};

const MAPPING_PRESETS: MappingPreset[] = [
  {
    name: "Primary + Hue",
    overrides: null,
  },
  {
    name: "Button",
    overrides: {
      directory:       { bg: "primary",   fg: "button-color-foreground" },
      git:             { bg: "secondary", fg: "button-color-foreground" },
      gitTaculous:     { bg: "secondary", fg: "button-color-foreground" },
      model:           { bg: "accent",    fg: "button-color-foreground" },
      session:         { bg: "success",   fg: "button-color-foreground" },
      context:         { bg: "panel",     fg: "foreground" },
      contextWarning:  { bg: "warning",   fg: "button-color-foreground" },
      contextCritical: { bg: "error",     fg: "button-color-foreground" },
      block:           { bg: "boost",     fg: "button-color-foreground" },
      today:           { bg: "primary",   fg: "button-color-foreground" },
      tmux:            { bg: "secondary", fg: "button-color-foreground" },
      metrics:         { bg: "accent",    fg: "button-color-foreground" },
      version:         { bg: "success",   fg: "button-color-foreground" },
      env:             { bg: "panel",     fg: "foreground" },
      weekly:          { bg: "boost",     fg: "button-color-foreground" },
    },
  },
  {
    name: "Muted + Text",
    overrides: {
      directory:       { bg: "primary-muted",   fg: "text-primary" },
      git:             { bg: "secondary-muted", fg: "text-secondary" },
      gitTaculous:     { bg: "secondary-muted", fg: "text-secondary" },
      model:           { bg: "accent-muted",    fg: "text-accent" },
      session:         { bg: "success-muted",   fg: "text-success" },
      context:         { bg: "warning-muted",   fg: "text-warning" },
      contextWarning:  { bg: "warning",         fg: "button-color-foreground" },
      contextCritical: { bg: "error",           fg: "button-color-foreground" },
      block:           { bg: "error-muted",     fg: "text-error" },
      today:           { bg: "primary-muted",   fg: "text-primary" },
      tmux:            { bg: "secondary-muted", fg: "text-secondary" },
      metrics:         { bg: "accent-muted",    fg: "text-accent" },
      version:         { bg: "success-muted",   fg: "text-success" },
      env:             { bg: "warning-muted",   fg: "text-warning" },
      weekly:          { bg: "error-muted",     fg: "text-error" },
    },
  },
  {
    name: "Surface + Foreground",
    overrides: {
      directory:       { bg: "surface",         fg: "foreground" },
      git:             { bg: "surface-active",  fg: "foreground" },
      gitTaculous:     { bg: "surface-active",  fg: "foreground" },
      model:           { bg: "panel",           fg: "foreground" },
      session:         { bg: "surface",         fg: "foreground" },
      context:         { bg: "surface-active",  fg: "foreground" },
      contextWarning:  { bg: "warning",         fg: "button-color-foreground" },
      contextCritical: { bg: "error",           fg: "button-color-foreground" },
      block:           { bg: "panel",           fg: "foreground" },
      today:           { bg: "surface",         fg: "foreground" },
      tmux:            { bg: "surface-active",  fg: "foreground" },
      metrics:         { bg: "panel",           fg: "foreground" },
      version:         { bg: "surface",         fg: "foreground" },
      env:             { bg: "surface-active",  fg: "foreground" },
      weekly:          { bg: "panel",           fg: "foreground" },
    },
  },
  {
    name: "Backgrounds + Button-fg",
    overrides: {
      directory:       { bg: "primary-background",   fg: "button-color-foreground" },
      git:             { bg: "secondary-background", fg: "button-color-foreground" },
      gitTaculous:     { bg: "secondary-background", fg: "button-color-foreground" },
      model:           { bg: "primary-background",   fg: "button-color-foreground" },
      session:         { bg: "secondary-background", fg: "button-color-foreground" },
      context:         { bg: "primary-background",   fg: "foreground" },
      contextWarning:  { bg: "warning",              fg: "button-color-foreground" },
      contextCritical: { bg: "error",                fg: "button-color-foreground" },
      block:           { bg: "secondary-background", fg: "button-color-foreground" },
      today:           { bg: "primary-background",   fg: "button-color-foreground" },
      tmux:            { bg: "secondary-background", fg: "button-color-foreground" },
      metrics:         { bg: "primary-background",   fg: "button-color-foreground" },
      version:         { bg: "secondary-background", fg: "button-color-foreground" },
      env:             { bg: "primary-background",   fg: "foreground" },
      weekly:          { bg: "secondary-background", fg: "button-color-foreground" },
    },
  },
  {
    name: "Text on Background",
    overrides: {
      directory:       { bg: "background", fg: "text-primary" },
      git:             { bg: "background", fg: "text-secondary" },
      gitTaculous:     { bg: "background", fg: "text-secondary" },
      model:           { bg: "background", fg: "text-accent" },
      session:         { bg: "background", fg: "text-success" },
      context:         { bg: "background", fg: "text-warning" },
      contextWarning:  { bg: "warning",    fg: "button-color-foreground" },
      contextCritical: { bg: "error",      fg: "button-color-foreground" },
      block:           { bg: "background", fg: "text-error" },
      today:           { bg: "background", fg: "text-primary" },
      tmux:            { bg: "background", fg: "text-secondary" },
      metrics:         { bg: "background", fg: "text-accent" },
      version:         { bg: "background", fg: "text-success" },
      env:             { bg: "background", fg: "text-muted" },
      weekly:          { bg: "background", fg: "text-error" },
    },
  },
];

// --- State ---

const themes = listAvailableThemes().filter((t) => t !== "custom");
const styles: StripStyle[] = ["powerline", "capsule", "plain"];

let themeIdx = themes.indexOf("gruvbox");
if (themeIdx === -1) themeIdx = 0;
let sampleIdx = 0;
let styleIdx = 0;
let mappingIdx = 0;
let hueStep: number | null = null;
const HUE_STEP_INCREMENT = 5;
let needsRender = true;

// --- ANSI helpers ---

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BG_DARK = "\x1b[48;5;236m";
const BG_PANEL = "\x1b[48;5;234m";

function hexToAnsiBg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function hexToAnsiFg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function colorToHex(c: ColorRgba): string {
  const r = c.red.toString(16).padStart(2, "0");
  const g = c.green.toString(16).padStart(2, "0");
  const b = c.blue.toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function stripAnsi(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      while (i < s.length && s[i] !== "m") i++;
      continue;
    }
    len++;
  }
  return len;
}

function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

function getTerminalHeight(): number {
  return process.stdout.rows ?? 24;
}

// --- Palette legend ---
// Every swatch shows two theme colors: one as background, one as foreground.
// Pairings match how Textual actually uses them in widget CSS.

interface LegendEntry {
  labels: string[];
  fg: string; // palette var name for text
  bg: string; // palette var name for background
}

const DEMO_TEXT = "The quick fox";

// Pairings sourced from Textual widget default CSS:
//   Button.-primary:  bg=$primary,    fg=$button-color-foreground
//   Button flat:      bg=$*-muted,    fg=$text-*
//   Header:           bg=$panel,      fg=$foreground
//   Footer:           bg=$panel,      fg=$foreground
//   Input:            bg=$surface,    fg=$foreground
//   Label.primary:    bg=$primary-muted, fg=$text-primary
const PALETTE_GROUPS: { title: string; entries: LegendEntry[] }[] = [
  {
    title: "Foreground / Background",
    entries: [
      { labels: ["foreground", "background"], fg: "foreground", bg: "background" },
      { labels: ["foreground-muted", "background"], fg: "foreground-muted", bg: "background" },
      { labels: ["foreground-disabled", "background"], fg: "foreground-disabled", bg: "background" },
    ],
  },
  {
    title: "Core (as Button backgrounds)",
    entries: [
      { labels: ["button-color-fg", "primary"], fg: "button-color-foreground", bg: "primary" },
      { labels: ["button-color-fg", "secondary"], fg: "button-color-foreground", bg: "secondary" },
      { labels: ["button-color-fg", "accent"], fg: "button-color-foreground", bg: "accent" },
      { labels: ["button-color-fg", "boost"], fg: "button-color-foreground", bg: "boost" },
      { labels: ["button-color-fg", "success"], fg: "button-color-foreground", bg: "success" },
      { labels: ["button-color-fg", "warning"], fg: "button-color-foreground", bg: "warning" },
      { labels: ["button-color-fg", "error"], fg: "button-color-foreground", bg: "error" },
    ],
  },
  {
    title: "Core Muted (as Label/flat Button backgrounds)",
    entries: [
      { labels: ["text-primary", "primary-muted"], fg: "text-primary", bg: "primary-muted" },
      { labels: ["text-secondary", "secondary-muted"], fg: "text-secondary", bg: "secondary-muted" },
      { labels: ["text-accent", "accent-muted"], fg: "text-accent", bg: "accent-muted" },
      { labels: ["text-success", "success-muted"], fg: "text-success", bg: "success-muted" },
      { labels: ["text-warning", "warning-muted"], fg: "text-warning", bg: "warning-muted" },
      { labels: ["text-error", "error-muted"], fg: "text-error", bg: "error-muted" },
    ],
  },
  {
    title: "Surfaces (as widget backgrounds)",
    entries: [
      { labels: ["foreground", "surface"], fg: "foreground", bg: "surface" },
      { labels: ["foreground", "panel"], fg: "foreground", bg: "panel" },
      { labels: ["foreground", "surface-active"], fg: "foreground", bg: "surface-active" },
    ],
  },
  {
    title: "Text (foreground on background)",
    entries: [
      { labels: ["text", "background"], fg: "text", bg: "background" },
      { labels: ["text-primary", "background"], fg: "text-primary", bg: "background" },
      { labels: ["text-secondary", "background"], fg: "text-secondary", bg: "background" },
      { labels: ["text-accent", "background"], fg: "text-accent", bg: "background" },
      { labels: ["text-muted", "background"], fg: "text-muted", bg: "background" },
      { labels: ["text-success", "background"], fg: "text-success", bg: "background" },
      { labels: ["text-warning", "background"], fg: "text-warning", bg: "background" },
      { labels: ["text-error", "background"], fg: "text-error", bg: "background" },
      { labels: ["text-disabled", "background"], fg: "text-disabled", bg: "background" },
    ],
  },
  {
    title: "Buttons & Borders",
    entries: [
      { labels: ["button-foreground", "surface"], fg: "button-foreground", bg: "surface" },
      { labels: ["button-color-fg", "primary-background"], fg: "button-color-foreground", bg: "primary-background" },
      { labels: ["button-color-fg", "secondary-background"], fg: "button-color-foreground", bg: "secondary-background" },
      { labels: ["foreground", "border"], fg: "foreground", bg: "border" },
      { labels: ["foreground", "border-blurred"], fg: "foreground", bg: "border-blurred" },
    ],
  },
  {
    title: "Cursor & Input",
    entries: [
      { labels: ["cursor-fg", "cursor-bg"], fg: "block-cursor-foreground", bg: "block-cursor-background" },
      { labels: ["cursor-blurred-fg", "cursor-blurred-bg"], fg: "block-cursor-blurred-foreground", bg: "block-cursor-blurred-background" },
      { labels: ["foreground", "block-hover-bg"], fg: "foreground", bg: "block-hover-background" },
      { labels: ["input-cursor-fg", "input-cursor-bg"], fg: "input-cursor-foreground", bg: "input-cursor-background" },
      { labels: ["foreground", "input-selection-bg"], fg: "foreground", bg: "input-selection-background" },
    ],
  },
  {
    title: "Links",
    entries: [
      { labels: ["link-color", "link-bg"], fg: "link-color", bg: "link-background" },
      { labels: ["link-color-hover", "link-bg-hover"], fg: "link-color-hover", bg: "link-background-hover" },
    ],
  },
  {
    title: "Scrollbar",
    entries: [
      { labels: ["foreground", "scrollbar"], fg: "foreground", bg: "scrollbar" },
      { labels: ["foreground", "scrollbar-hover"], fg: "foreground", bg: "scrollbar-hover" },
      { labels: ["foreground", "scrollbar-active"], fg: "foreground", bg: "scrollbar-active" },
      { labels: ["foreground", "scrollbar-bg"], fg: "foreground", bg: "scrollbar-background" },
      { labels: ["foreground", "scrollbar-bg-hover"], fg: "foreground", bg: "scrollbar-background-hover" },
      { labels: ["foreground", "scrollbar-bg-active"], fg: "foreground", bg: "scrollbar-background-active" },
      { labels: ["foreground", "scrollbar-corner"], fg: "foreground", bg: "scrollbar-corner-color" },
    ],
  },
  {
    title: "Footer",
    entries: [
      { labels: ["footer-fg", "footer-bg"], fg: "footer-foreground", bg: "footer-background" },
      { labels: ["footer-desc-fg", "footer-desc-bg"], fg: "footer-description-foreground", bg: "footer-description-background" },
      { labels: ["foreground", "footer-item-bg"], fg: "foreground", bg: "footer-item-background" },
      { labels: ["footer-key-fg", "footer-key-bg"], fg: "footer-key-foreground", bg: "footer-key-background" },
    ],
  },
  {
    title: "Markdown Headings",
    entries: [
      { labels: ["h1-color", "h1-bg"], fg: "markdown-h1-color", bg: "markdown-h1-background" },
      { labels: ["h2-color", "h2-bg"], fg: "markdown-h2-color", bg: "markdown-h2-background" },
      { labels: ["h3-color", "h3-bg"], fg: "markdown-h3-color", bg: "markdown-h3-background" },
      { labels: ["h4-color", "h4-bg"], fg: "markdown-h4-color", bg: "markdown-h4-background" },
      { labels: ["h5-color", "h5-bg"], fg: "markdown-h5-color", bg: "markdown-h5-background" },
      { labels: ["h6-color", "h6-bg"], fg: "markdown-h6-color", bg: "markdown-h6-background" },
    ],
  },
];

const GAP = 2;

function buildPaletteLegend(width: number): string[] {
  const palette = getThemePalette(themes[themeIdx]!);
  if (!palette) return [];

  const lines: string[] = [];

  for (const group of PALETTE_GROUPS) {
    lines.push(`${DIM}  ${group.title}${RESET}`);

    const swatchVisible = DEMO_TEXT.length + 2;
    const maxLabelsLen = Math.max(
      ...group.entries.map((e) => e.labels.join("  ").length),
    );
    const entryWidth = swatchVisible + 1 + maxLabelsLen + GAP;
    const cols = Math.max(1, Math.floor(width / entryWidth));

    for (let rowStart = 0; rowStart < group.entries.length; rowStart += cols) {
      const row = group.entries.slice(rowStart, rowStart + cols);
      let line = "";
      for (const entry of row) {
        const fgRgba = palette.vars.get(entry.fg);
        const bgRgba = palette.vars.get(entry.bg);
        if (!fgRgba || !bgRgba) {
          line += `${DIM}[${DEMO_TEXT}] ${entry.labels.join("  ")}${RESET}${" ".repeat(GAP)}`;
          continue;
        }
        const fgHex = colorToHex(fgRgba);
        const bgHex = colorToHex(bgRgba);
        const swatch = `${hexToAnsiBg(bgHex)}${hexToAnsiFg(fgHex)} ${DEMO_TEXT} ${RESET}`;
        const labels = entry.labels.join("  ").padEnd(maxLabelsLen);
        line += `${swatch} ${DIM}${labels}${RESET}${" ".repeat(GAP)}`;
      }
      lines.push(line);
    }
  }

  return lines;
}

// --- Powerline rendering ---

function buildPowerlineBar(): string {
  const theme = themes[themeIdx]!;
  const sample = MOCK_SAMPLES[sampleIdx]!;
  const style = styles[styleIdx]!;
  const preset = MAPPING_PRESETS[mappingIdx]!;

  const colors = resolveThemeColors({
    theme,
    hueStep: hueStep ?? undefined,
    themeMapping: preset.overrides ?? undefined,
    colorSupport: "truecolor",
  });

  const hex = colors.hex;
  if (!hex) return "(no hex colors available)";

  const segments = sample.segments
    .map((seg: MockSegment) => {
      const keys = SEGMENT_COLOR_KEYS[seg.type];
      if (!keys) return null;
      return {
        type: seg.type,
        text: seg.text,
        bgHex: hex[keys.bg],
        fgHex: hex[keys.fg],
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const width = getTerminalWidth() - 2;
  return buildFlexStripLines(segments, {
    style,
    colorCompatibility: "truecolor",
    width,
  });
}

function buildColorSwatches(): string {
  const theme = themes[themeIdx]!;
  const preset = MAPPING_PRESETS[mappingIdx]!;

  const colors = resolveThemeColors({
    theme,
    hueStep: hueStep ?? undefined,
    themeMapping: preset.overrides ?? undefined,
    colorSupport: "truecolor",
  });

  const hex = colors.hex;
  if (!hex) return "";

  const entries = Object.entries(SEGMENT_COLOR_KEYS);
  const parts: string[] = [];
  for (const [name, keys] of entries) {
    const bg = hex[keys.bg];
    const fg = hex[keys.fg];
    parts.push(
      `${hexToAnsiBg(bg)}${hexToAnsiFg(fg)} ${name.slice(0, 4).padEnd(4)} ${RESET}`,
    );
  }
  return parts.join("");
}

// --- Main render ---

function render(): void {
  const width = getTerminalWidth();
  const height = getTerminalHeight();
  const innerWidth = width - 2;

  const theme = themes[themeIdx]!;
  const sample = MOCK_SAMPLES[sampleIdx]!;
  const style = styles[styleIdx]!;
  const preset = MAPPING_PRESETS[mappingIdx]!;
  const hueLabel = hueStep === null ? "default" : `${hueStep}°`;

  const lines: string[] = [];

  // Title
  const title = ` Claude Powerline Theme Explorer `;
  const titlePad = innerWidth - title.length;
  const titleLeft = Math.floor(titlePad / 2);
  lines.push(
    `${BG_PANEL}${BOLD}${" ".repeat(titleLeft)}${title}${" ".repeat(titlePad - titleLeft)}${RESET}`,
  );
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);

  // Powerline bar
  const bar = buildPowerlineBar();
  const barDisplay = bar.replace(/\x1b\[0m$/, "");
  lines.push(`${BG_DARK} ${barDisplay}${RESET}`);

  // Spacer
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);

  // Segment color swatches
  const swatchLine = buildColorSwatches();
  lines.push(
    `${BG_DARK} ${swatchLine.slice(0, innerWidth * 3)}${RESET}`,
  );
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);

  // Palette legend header
  lines.push(
    `${BG_PANEL}${BOLD} Palette: ${theme}${RESET}`,
  );

  // Palette legend (fills remaining space before controls)
  const paletteLines = buildPaletteLegend(width);
  const controlsReserve = 3;
  const availableLines = height - lines.length - controlsReserve;
  const paletteLinesToShow = Math.min(
    paletteLines.length,
    Math.max(2, availableLines),
  );

  for (let i = 0; i < paletteLinesToShow; i++) {
    lines.push(paletteLines[i]!);
  }

  // Controls
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);
  const mappingLabel = `Mapping: [m] ${preset.name} (${mappingIdx + 1}/${MAPPING_PRESETS.length})`;
  const themeLabel = `Theme: [←/→] ${theme}`;
  const styleLabel = `Style: [s] ${style}`;
  const sampleLabel = `Sample: [↑/↓] ${sampleIdx + 1}/${MOCK_SAMPLES.length}`;
  const hueLine = `Hue: [,/.] ${hueLabel}  [+/-] ±${HUE_STEP_INCREMENT}°  [0] default`;
  const quitLabel = "[q] Quit";

  lines.push(
    `${BG_PANEL} ${mappingLabel}    ${themeLabel}    ${styleLabel}${RESET}`,
  );
  lines.push(
    `${BG_PANEL} ${sampleLabel}    ${hueLine}${" ".repeat(Math.max(1, innerWidth - stripAnsi(sampleLabel) - stripAnsi(hueLine) - quitLabel.length - 6))}${quitLabel} ${RESET}`,
  );

  // Write
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(lines.join("\n") + "\n");
}

// --- Input handling ---

function handleInput(data: Buffer): void {
  const bytes = data;

  // Ctrl+C
  if (bytes.length === 1 && bytes[0] === 3) {
    cleanup();
    process.exit(0);
  }

  // Single character keys
  if (bytes.length === 1) {
    const ch = bytes[0]!;
    if (ch === 113) {
      // q
      cleanup();
      process.exit(0);
    }
    if (ch === 109) {
      // m
      mappingIdx = (mappingIdx + 1) % MAPPING_PRESETS.length;
      needsRender = true;
    }
    if (ch === 77) {
      // M (shift+m)
      mappingIdx = (mappingIdx - 1 + MAPPING_PRESETS.length) % MAPPING_PRESETS.length;
      needsRender = true;
    }
    if (ch === 115) {
      // s
      styleIdx = (styleIdx + 1) % styles.length;
      needsRender = true;
    }
    if (ch === 48) {
      // 0
      hueStep = null;
      needsRender = true;
    }
    if (ch === 43 || ch === 93 || ch === 46) {
      // + or ] or .
      hueStep = (hueStep ?? 0) + HUE_STEP_INCREMENT;
      needsRender = true;
    }
    if (ch === 45 || ch === 91 || ch === 44) {
      // - or [ or ,
      const next = (hueStep ?? 0) - HUE_STEP_INCREMENT;
      hueStep = next <= 0 ? null : next;
      needsRender = true;
    }
  }

  // Arrow keys: ESC [ A/B/C/D
  if (bytes.length === 3 && bytes[0] === 27 && bytes[1] === 91) {
    const dir = bytes[2]!;
    if (dir === 67) {
      themeIdx = (themeIdx + 1) % themes.length;
      needsRender = true;
    }
    if (dir === 68) {
      themeIdx = (themeIdx - 1 + themes.length) % themes.length;
      needsRender = true;
    }
    if (dir === 65) {
      sampleIdx = (sampleIdx + 1) % MOCK_SAMPLES.length;
      needsRender = true;
    }
    if (dir === 66) {
      sampleIdx = (sampleIdx - 1 + MOCK_SAMPLES.length) % MOCK_SAMPLES.length;
      needsRender = true;
    }
  }
}

// --- Lifecycle ---

function cleanup(): void {
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

function main(): void {
  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l");

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleInput);

  process.stdout.on("resize", () => {
    needsRender = true;
  });

  const frame = (): void => {
    if (needsRender) {
      needsRender = false;
      render();
    }
    setTimeout(frame, 50);
  };
  frame();

  process.on("uncaughtException", (err) => {
    cleanup();
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

main();
