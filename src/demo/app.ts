import process from "node:process";
import { resolveThemeColors, listAvailableThemes } from "../themes/index.js";
import { getThemePalette } from "../themes/palette-registry.js";
import type { PowerlineHexColors } from "../themes/index.js";
import {
  buildFlexStripLines,
  type StripStyle,
} from "../render/strip.js";
import { MOCK_SAMPLES, type MockSegment } from "./mock-data.js";
import type { ColorRgba } from "rich-js";

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

// --- State ---

const themes = listAvailableThemes().filter((t) => t !== "custom");
const styles: StripStyle[] = ["powerline", "capsule", "plain"];

let themeIdx = themes.indexOf("gruvbox");
if (themeIdx === -1) themeIdx = 0;
let sampleIdx = 0;
let styleIdx = 0;
// null = default curated offsets; number = uniform hueStep in degrees
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
      // skip to terminator
      while (i < s.length && s[i] !== "m") i++;
      continue;
    }
    len++;
  }
  return len;
}

function padRightAnsi(s: string, width: number): string {
  const visible = stripAnsi(s);
  if (visible >= width) return s;
  return s + " ".repeat(width - visible);
}

function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

function getTerminalHeight(): number {
  return process.stdout.rows ?? 24;
}

// --- Palette legend ---

// Each entry is either a flat color or a fg/bg pair.
// Pairs render as a single swatch: fg text on bg background.
interface LegendFlat {
  label: string;
  color: string; // palette var name
}

interface LegendPair {
  label: string;
  fg: string; // palette var name for text
  bg: string; // palette var name for background
}

type LegendEntry = LegendFlat | LegendPair;

function isPair(e: LegendEntry): e is LegendPair {
  return "fg" in e;
}

const PALETTE_GROUPS: { title: string; entries: LegendEntry[] }[] = [
  {
    title: "Core",
    entries: [
      { label: "primary", color: "primary" },
      { label: "secondary", color: "secondary" },
      { label: "accent", color: "accent" },
      { label: "boost", color: "boost" },
      { label: "success", color: "success" },
      { label: "warning", color: "warning" },
      { label: "error", color: "error" },
    ],
  },
  {
    title: "Surfaces",
    entries: [
      { label: "background", color: "background" },
      { label: "foreground", color: "foreground" },
      { label: "panel", color: "panel" },
      { label: "surface", color: "surface" },
      { label: "surface-active", color: "surface-active" },
      { label: "foreground-disabled", color: "foreground-disabled" },
    ],
  },
  {
    title: "Text",
    entries: [
      { label: "text", fg: "text", bg: "background" },
      { label: "text-primary", fg: "text-primary", bg: "background" },
      { label: "text-secondary", fg: "text-secondary", bg: "background" },
      { label: "text-accent", fg: "text-accent", bg: "background" },
      { label: "text-muted", fg: "text-muted", bg: "background" },
      { label: "text-success", fg: "text-success", bg: "background" },
      { label: "text-warning", fg: "text-warning", bg: "background" },
      { label: "text-error", fg: "text-error", bg: "background" },
      { label: "text-disabled", fg: "text-disabled", bg: "background" },
    ],
  },
  {
    title: "Borders & Buttons",
    entries: [
      { label: "border", color: "border" },
      { label: "border-blurred", color: "border-blurred" },
      { label: "button", fg: "button-foreground", bg: "primary-background" },
      { label: "button-color", fg: "button-color-foreground", bg: "primary-background" },
    ],
  },
  {
    title: "Cursor & Input",
    entries: [
      { label: "block-cursor", fg: "block-cursor-foreground", bg: "block-cursor-background" },
      { label: "block-blurred", fg: "block-cursor-blurred-foreground", bg: "block-cursor-blurred-background" },
      { label: "block-hover", color: "block-hover-background" },
      { label: "input-cursor", fg: "input-cursor-foreground", bg: "input-cursor-background" },
      { label: "input-selection", color: "input-selection-background" },
    ],
  },
  {
    title: "Links",
    entries: [
      { label: "link", fg: "link-color", bg: "link-background" },
      { label: "link-hover", fg: "link-color-hover", bg: "link-background-hover" },
    ],
  },
  {
    title: "Scrollbar",
    entries: [
      { label: "scrollbar", fg: "foreground", bg: "scrollbar" },
      { label: "scrollbar-hover", fg: "foreground", bg: "scrollbar-hover" },
      { label: "scrollbar-active", fg: "foreground", bg: "scrollbar-active" },
      { label: "scrollbar-bg", color: "scrollbar-background" },
      { label: "scrollbar-bg-hover", color: "scrollbar-background-hover" },
      { label: "scrollbar-bg-active", color: "scrollbar-background-active" },
      { label: "scrollbar-corner", color: "scrollbar-corner-color" },
    ],
  },
  {
    title: "Footer",
    entries: [
      { label: "footer", fg: "footer-foreground", bg: "footer-background" },
      { label: "footer-desc", fg: "footer-description-foreground", bg: "footer-description-background" },
      { label: "footer-item", color: "footer-item-background" },
      { label: "footer-key", fg: "footer-key-foreground", bg: "footer-key-background" },
    ],
  },
  {
    title: "Markdown Headings",
    entries: [
      { label: "h1", fg: "markdown-h1-color", bg: "markdown-h1-background" },
      { label: "h2", fg: "markdown-h2-color", bg: "markdown-h2-background" },
      { label: "h3", fg: "markdown-h3-color", bg: "markdown-h3-background" },
      { label: "h4", fg: "markdown-h4-color", bg: "markdown-h4-background" },
      { label: "h5", fg: "markdown-h5-color", bg: "markdown-h5-background" },
      { label: "h6", fg: "markdown-h6-color", bg: "markdown-h6-background" },
    ],
  },
  {
    title: "Primary / Secondary Backgrounds",
    entries: [
      { label: "primary-bg", color: "primary-background" },
      { label: "secondary-bg", color: "secondary-background" },
    ],
  },
];

const SWATCH_PAD = 2;
const GAP = 2;

function resolveRgba(
  palette: { vars: ReadonlyMap<string, ColorRgba> },
  name: string,
): ColorRgba | null {
  return palette.vars.get(name) ?? null;
}

function contrastFg(rgba: ColorRgba): string {
  const bright = rgba.red > 128 && rgba.green > 128 && rgba.blue > 128;
  return bright ? "#000000" : "#ffffff";
}

function buildPaletteLegend(width: number): string[] {
  const palette = getThemePalette(themes[themeIdx]!);
  if (!palette) return [];

  const lines: string[] = [];

  for (const group of PALETTE_GROUPS) {
    lines.push(`${DIM}  ${group.title}${RESET}`);

    const maxLabelLen = Math.max(...group.entries.map((e) => e.label.length));
    const colWidth = maxLabelLen + SWATCH_PAD + GAP;
    const cols = Math.max(1, Math.floor(width / colWidth));

    for (let rowStart = 0; rowStart < group.entries.length; rowStart += cols) {
      const row = group.entries.slice(rowStart, rowStart + cols);
      let line = "";
      for (const entry of row) {
        const padded = entry.label.padEnd(maxLabelLen);

        if (isPair(entry)) {
          const fgRgba = resolveRgba(palette, entry.fg);
          const bgRgba = resolveRgba(palette, entry.bg);
          if (!fgRgba || !bgRgba) {
            line += `${DIM} ${padded} ${RESET}${" ".repeat(GAP)}`;
            continue;
          }
          const bgHex = colorToHex(bgRgba);
          const fgHex = colorToHex(fgRgba);
          line += `${hexToAnsiBg(bgHex)}${hexToAnsiFg(fgHex)} ${padded} ${RESET}${" ".repeat(GAP)}`;
        } else {
          const rgba = resolveRgba(palette, entry.color);
          if (!rgba) {
            line += `${DIM} ${padded} ${RESET}${" ".repeat(GAP)}`;
            continue;
          }
          const hex = colorToHex(rgba);
          const fg = contrastFg(rgba);
          line += `${hexToAnsiBg(hex)}${hexToAnsiFg(fg)} ${padded} ${RESET}${" ".repeat(GAP)}`;
        }
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

  const colors = resolveThemeColors({
    theme,
    hueStep: hueStep ?? undefined,
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

  const colors = resolveThemeColors({
    theme,
    hueStep: hueStep ?? undefined,
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
  const controlsReserve = 3; // controls + spacer + bottom
  const availableLines = height - lines.length - controlsReserve;
  const paletteLinesToShow = Math.min(paletteLines.length, Math.max(2, availableLines));

  for (let i = 0; i < paletteLinesToShow; i++) {
    lines.push(paletteLines[i]!);
  }

  // Controls
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);
  const themeLabel = `Theme: [←/→] ${theme}`;
  const styleLabel = `Style: [s] ${style}`;
  const sampleLabel = `Sample: [↑/↓] ${sampleIdx + 1}/${MOCK_SAMPLES.length} ${sample.name}`;
  const hueStepLine = `Hue Step: [  ] ${hueLabel}  [+/-] ±${HUE_STEP_INCREMENT}°  [0] default`;
  const quitLabel = "[q] Quit";

  lines.push(
    `${BG_PANEL} ${themeLabel}    ${styleLabel}    ${sampleLabel}${RESET}`,
  );
  lines.push(
    `${BG_PANEL} ${hueStepLine}${" ".repeat(Math.max(1, innerWidth - stripAnsi(hueStepLine) - quitLabel.length - 2))}${quitLabel} ${RESET}`,
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
    // + (0x2B or shift+= on some keyboards) or ] (0x5D)
    if (ch === 43 || ch === 93) {
      hueStep = (hueStep ?? 0) + HUE_STEP_INCREMENT;
      needsRender = true;
    }
    // - (0x2D) or [ (0x5B)
    if (ch === 45 || ch === 91) {
      const next = (hueStep ?? 0) - HUE_STEP_INCREMENT;
      hueStep = next <= 0 ? null : next;
      needsRender = true;
    }
    if (ch === 114) {
      // r
      needsRender = true;
    }
  }

  // Arrow keys: ESC [ A/B/C/D
  if (bytes.length === 3 && bytes[0] === 27 && bytes[1] === 91) {
    const dir = bytes[2]!;
    if (dir === 67) {
      // right
      themeIdx = (themeIdx + 1) % themes.length;
      needsRender = true;
    }
    if (dir === 68) {
      // left
      themeIdx = (themeIdx - 1 + themes.length) % themes.length;
      needsRender = true;
    }
    if (dir === 65) {
      // up
      sampleIdx = (sampleIdx + 1) % MOCK_SAMPLES.length;
      needsRender = true;
    }
    if (dir === 66) {
      // down
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
