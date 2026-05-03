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
  labels: string[];
  color: string; // palette var name
}

interface LegendPair {
  labels: string[];
  fg: string; // palette var name for text
  bg: string; // palette var name for background
}

type LegendEntry = LegendFlat | LegendPair;

function isPair(e: LegendEntry): e is LegendPair {
  return "fg" in e;
}

const DEMO_TEXT = "The quick fox";

const PALETTE_GROUPS: { title: string; entries: LegendEntry[] }[] = [
  {
    title: "Core",
    entries: [
      { labels: ["primary"], color: "primary" },
      { labels: ["secondary"], color: "secondary" },
      { labels: ["accent"], color: "accent" },
      { labels: ["boost"], color: "boost" },
      { labels: ["success"], color: "success" },
      { labels: ["warning"], color: "warning" },
      { labels: ["error"], color: "error" },
    ],
  },
  {
    title: "Surfaces",
    entries: [
      { labels: ["background"], color: "background" },
      { labels: ["foreground"], color: "foreground" },
      { labels: ["panel"], color: "panel" },
      { labels: ["surface"], color: "surface" },
      { labels: ["surface-active"], color: "surface-active" },
      { labels: ["foreground-disabled"], color: "foreground-disabled" },
    ],
  },
  {
    title: "Text",
    entries: [
      { labels: ["text"], fg: "text", bg: "background" },
      { labels: ["text-primary"], fg: "text-primary", bg: "background" },
      { labels: ["text-secondary"], fg: "text-secondary", bg: "background" },
      { labels: ["text-accent"], fg: "text-accent", bg: "background" },
      { labels: ["text-muted"], fg: "text-muted", bg: "background" },
      { labels: ["text-success"], fg: "text-success", bg: "background" },
      { labels: ["text-warning"], fg: "text-warning", bg: "background" },
      { labels: ["text-error"], fg: "text-error", bg: "background" },
      { labels: ["text-disabled"], fg: "text-disabled", bg: "background" },
    ],
  },
  {
    title: "Borders & Buttons",
    entries: [
      { labels: ["border"], color: "border" },
      { labels: ["border-blurred"], color: "border-blurred" },
      { labels: ["button-foreground", "primary-background"], fg: "button-foreground", bg: "primary-background" },
      { labels: ["button-color-foreground", "primary-background"], fg: "button-color-foreground", bg: "primary-background" },
    ],
  },
  {
    title: "Cursor & Input",
    entries: [
      { labels: ["block-cursor-fg", "block-cursor-bg"], fg: "block-cursor-foreground", bg: "block-cursor-background" },
      { labels: ["block-blurred-fg", "block-blurred-bg"], fg: "block-cursor-blurred-foreground", bg: "block-cursor-blurred-background" },
      { labels: ["block-hover-background"], color: "block-hover-background" },
      { labels: ["input-cursor-fg", "input-cursor-bg"], fg: "input-cursor-foreground", bg: "input-cursor-background" },
      { labels: ["input-selection"], color: "input-selection-background" },
    ],
  },
  {
    title: "Links",
    entries: [
      { labels: ["link-color", "link-background"], fg: "link-color", bg: "link-background" },
      { labels: ["link-color-hover", "link-bg-hover"], fg: "link-color-hover", bg: "link-background-hover" },
    ],
  },
  {
    title: "Scrollbar",
    entries: [
      { labels: ["scrollbar"], fg: "foreground", bg: "scrollbar" },
      { labels: ["scrollbar-hover"], fg: "foreground", bg: "scrollbar-hover" },
      { labels: ["scrollbar-active"], fg: "foreground", bg: "scrollbar-active" },
      { labels: ["scrollbar-background"], color: "scrollbar-background" },
      { labels: ["scrollbar-bg-hover"], color: "scrollbar-background-hover" },
      { labels: ["scrollbar-bg-active"], color: "scrollbar-background-active" },
      { labels: ["scrollbar-corner"], color: "scrollbar-corner-color" },
    ],
  },
  {
    title: "Footer",
    entries: [
      { labels: ["footer-fg", "footer-bg"], fg: "footer-foreground", bg: "footer-background" },
      { labels: ["footer-desc-fg", "footer-desc-bg"], fg: "footer-description-foreground", bg: "footer-description-background" },
      { labels: ["footer-item-bg"], color: "footer-item-background" },
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
  {
    title: "Primary / Secondary Backgrounds",
    entries: [
      { labels: ["primary-background"], color: "primary-background" },
      { labels: ["secondary-background"], color: "secondary-background" },
    ],
  },
];

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

    // Each entry renders as: [swatch DEMO_TEXT] label1 label2
    // Column width = swatch width + max labels text + gap
    const swatchVisible = DEMO_TEXT.length + 2; // spaces around demo text
    const maxLabelsLen = Math.max(
      ...group.entries.map((e) => e.labels.join("  ").length),
    );
    const entryWidth = swatchVisible + 1 + maxLabelsLen + GAP;
    const cols = Math.max(1, Math.floor(width / entryWidth));

    for (let rowStart = 0; rowStart < group.entries.length; rowStart += cols) {
      const row = group.entries.slice(rowStart, rowStart + cols);
      let line = "";
      for (const entry of row) {
        if (isPair(entry)) {
          const fgRgba = resolveRgba(palette, entry.fg);
          const bgRgba = resolveRgba(palette, entry.bg);
          if (!fgRgba || !bgRgba) {
            line += `${DIM}[${DEMO_TEXT}] ${entry.labels.join("  ")}${RESET}${" ".repeat(GAP)}`;
            continue;
          }
          const bgHex = colorToHex(bgRgba);
          const fgHex = colorToHex(fgRgba);
          const swatch = `${hexToAnsiBg(bgHex)}${hexToAnsiFg(fgHex)} ${DEMO_TEXT} ${RESET}`;
          const labels = entry.labels.join("  ").padEnd(maxLabelsLen);
          line += `${swatch} ${DIM}${labels}${RESET}${" ".repeat(GAP)}`;
        } else {
          const rgba = resolveRgba(palette, entry.color);
          if (!rgba) {
            line += `${DIM}[${DEMO_TEXT}] ${entry.labels.join("  ")}${RESET}${" ".repeat(GAP)}`;
            continue;
          }
          const hex = colorToHex(rgba);
          const fg = contrastFg(rgba);
          const swatch = `${hexToAnsiBg(hex)}${hexToAnsiFg(fg)} ${DEMO_TEXT} ${RESET}`;
          const labels = entry.labels.join("  ").padEnd(maxLabelsLen);
          line += `${swatch} ${DIM}${labels}${RESET}${" ".repeat(GAP)}`;
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
