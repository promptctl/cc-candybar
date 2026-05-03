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
    name: "Semantic",
    overrides: {
      directory: { bg: "primary" },
      git: { bg: "secondary" },
      model: { bg: "accent" },
      session: { bg: "success" },
      context: { bg: "panel" },
      contextWarning: { bg: "warning" },
      contextCritical: { bg: "error" },
      block: { bg: "boost" },
      today: { bg: "primary" },
      tmux: { bg: "secondary" },
      metrics: { bg: "accent" },
      version: { bg: "success" },
      env: { bg: "panel" },
      weekly: { bg: "boost" },
    },
  },
  {
    name: "Muted",
    overrides: {
      directory: { bg: "primary-muted" },
      git: { bg: "secondary-muted" },
      model: { bg: "accent-muted" },
      session: { bg: "success-muted" },
      context: { bg: "warning-muted" },
      contextWarning: { bg: "warning" },
      contextCritical: { bg: "error" },
      block: { bg: "error-muted" },
      today: { bg: "primary-muted" },
      tmux: { bg: "secondary-muted" },
      metrics: { bg: "accent-muted" },
      version: { bg: "success-muted" },
      env: { bg: "warning-muted" },
      weekly: { bg: "error-muted" },
    },
  },
  {
    name: "Surface",
    overrides: {
      directory: { bg: "surface" },
      git: { bg: "surface-active" },
      model: { bg: "panel" },
      session: { bg: "surface" },
      context: { bg: "surface-active" },
      contextWarning: { bg: "warning" },
      contextCritical: { bg: "error" },
      block: { bg: "panel" },
      today: { bg: "surface" },
      tmux: { bg: "surface-active" },
      metrics: { bg: "panel" },
      version: { bg: "surface" },
      env: { bg: "surface-active" },
      weekly: { bg: "panel" },
    },
  },
  {
    name: "Core 3-Hue",
    overrides: {
      directory: { bg: "primary", hue: 0 },
      git: { bg: "primary", hue: 0 },
      model: { bg: "secondary", hue: 0 },
      session: { bg: "secondary", hue: 0 },
      context: { bg: "accent", hue: 0 },
      contextWarning: { bg: "warning" },
      contextCritical: { bg: "error" },
      block: { bg: "primary", hue: 0 },
      today: { bg: "secondary", hue: 0 },
      tmux: { bg: "accent", hue: 0 },
      metrics: { bg: "primary", hue: 0 },
      version: { bg: "secondary", hue: 0 },
      env: { bg: "accent", hue: 0 },
      weekly: { bg: "primary", hue: 0 },
    },
  },
  {
    name: "Backgrounds",
    overrides: {
      directory: { bg: "primary-background" },
      git: { bg: "secondary-background" },
      model: { bg: "primary-background" },
      session: { bg: "secondary-background" },
      context: { bg: "primary-background" },
      contextWarning: { bg: "warning" },
      contextCritical: { bg: "error" },
      block: { bg: "secondary-background" },
      today: { bg: "primary-background" },
      tmux: { bg: "secondary-background" },
      metrics: { bg: "primary-background" },
      version: { bg: "secondary-background" },
      env: { bg: "primary-background" },
      weekly: { bg: "secondary-background" },
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

interface LegendEntry {
  labels: string[];
  fg: string;
  bg: string;
}

const DEMO_TEXT = "The quick fox";

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
    title: "Core",
    entries: [
      { labels: ["foreground", "primary"], fg: "foreground", bg: "primary" },
      { labels: ["foreground", "secondary"], fg: "foreground", bg: "secondary" },
      { labels: ["foreground", "accent"], fg: "foreground", bg: "accent" },
      { labels: ["foreground", "boost"], fg: "foreground", bg: "boost" },
      { labels: ["foreground", "success"], fg: "foreground", bg: "success" },
      { labels: ["foreground", "warning"], fg: "foreground", bg: "warning" },
      { labels: ["foreground", "error"], fg: "foreground", bg: "error" },
    ],
  },
  {
    title: "Core Muted",
    entries: [
      { labels: ["foreground", "primary-muted"], fg: "foreground", bg: "primary-muted" },
      { labels: ["foreground", "secondary-muted"], fg: "foreground", bg: "secondary-muted" },
      { labels: ["foreground", "accent-muted"], fg: "foreground", bg: "accent-muted" },
      { labels: ["foreground", "success-muted"], fg: "foreground", bg: "success-muted" },
      { labels: ["foreground", "warning-muted"], fg: "foreground", bg: "warning-muted" },
      { labels: ["foreground", "error-muted"], fg: "foreground", bg: "error-muted" },
    ],
  },
  {
    title: "Surfaces",
    entries: [
      { labels: ["foreground", "surface"], fg: "foreground", bg: "surface" },
      { labels: ["foreground", "panel"], fg: "foreground", bg: "panel" },
      { labels: ["foreground", "surface-active"], fg: "foreground", bg: "surface-active" },
      { labels: ["foreground", "primary-background"], fg: "foreground", bg: "primary-background" },
      { labels: ["foreground", "secondary-background"], fg: "foreground", bg: "secondary-background" },
    ],
  },
  {
    title: "Borders & Buttons",
    entries: [
      { labels: ["foreground", "border"], fg: "foreground", bg: "border" },
      { labels: ["foreground", "border-blurred"], fg: "foreground", bg: "border-blurred" },
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
  const hueLine = `Hue: [  ] ${hueLabel}  [+/-] ±${HUE_STEP_INCREMENT}°  [0] default`;
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
    if (ch === 43 || ch === 93) {
      // + or ]
      hueStep = (hueStep ?? 0) + HUE_STEP_INCREMENT;
      needsRender = true;
    }
    if (ch === 45 || ch === 91) {
      // - or [
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
