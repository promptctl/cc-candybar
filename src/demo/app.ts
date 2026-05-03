import process from "node:process";
import { resolveThemeColors, listAvailableThemes } from "../themes/index.js";
import type { PowerlineHexColors } from "../themes/index.js";
import {
  buildFlexStripLines,
  type StripStyle,
} from "../render/strip.js";
import { MOCK_SAMPLES, type MockSegment } from "./mock-data.js";

// --- Segment type → PowerlineHexColors key mapping ---
// Exclude `partFg` — it's a Record<string, string>, not a hex string.

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
const HUE_STEPS = [null, 15, 30, 45, 60, 90, 120] as const;

let themeIdx = themes.indexOf("gruvbox");
if (themeIdx === -1) themeIdx = 0;
let sampleIdx = 0;
let styleIdx = 0;
let hueStepIdx = 0;
let needsRender = true;

// --- Rendering helpers ---

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

function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

function buildPowerlineBar(): string {
  const theme = themes[themeIdx]!;
  const sample = MOCK_SAMPLES[sampleIdx]!;
  const style = styles[styleIdx]!;
  const hueStep = HUE_STEPS[hueStepIdx]!;

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

  const width = getTerminalWidth() - 2; // account for box borders
  return buildFlexStripLines(segments, {
    style,
    colorCompatibility: "truecolor",
    width,
  });
}

function buildColorSwatches(): string {
  const theme = themes[themeIdx]!;
  const hueStep = HUE_STEPS[hueStepIdx]!;

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
    // [LAW:dataflow-not-control-flow] every segment produces a swatch —
    // the data decides color, not a branch.
    parts.push(`${hexToAnsiBg(bg)}${hexToAnsiFg(fg)} ${name.slice(0, 4).padEnd(4)} ${RESET}`);
  }
  return parts.join("");
}

function render(): void {
  const width = getTerminalWidth();
  const innerWidth = width - 2; // box borders

  const theme = themes[themeIdx]!;
  const sample = MOCK_SAMPLES[sampleIdx]!;
  const style = styles[styleIdx]!;
  const hueStep = HUE_STEPS[hueStepIdx]!;

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
  // Strip trailing reset for embedding — we add our own line reset
  const barDisplay = bar.replace(/\x1b\[0m$/, "");
  lines.push(`${BG_DARK} ${barDisplay}${RESET}`);

  // Spacer
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);

  // Color swatches (two rows)
  const swatchLine = buildColorSwatches();
  // Truncate to innerWidth visible chars
  lines.push(`${BG_DARK} ${swatchLine.slice(0, innerWidth * 3)}${RESET}`);
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);

  // Controls
  const themeLabel = `Theme: [←/→] ${theme}`;
  const styleLabel = `Style: [s] ${style}`;
  const sampleLabel = `Sample: [↑/↓] ${sampleIdx + 1}/${MOCK_SAMPLES.length} ${sample.name}`;
  const hueStepLabel = `Hue Step: [h] ${hueStep ?? "off"}`;
  const quitLabel = "[q] Quit  [r] Refresh";

  lines.push(
    `${BG_PANEL} ${themeLabel}    ${styleLabel}    ${sampleLabel}${RESET}`,
  );
  lines.push(
    `${BG_PANEL} ${hueStepLabel}${" ".repeat(Math.max(1, innerWidth - hueStepLabel.length - quitLabel.length - 2))}${quitLabel} ${RESET}`,
  );

  // Write to terminal
  process.stdout.write("\x1b[2J\x1b[H"); // clear + home
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
    if (ch === 113) { // q
      cleanup();
      process.exit(0);
    }
    if (ch === 115) { // s
      styleIdx = (styleIdx + 1) % styles.length;
      needsRender = true;
    }
    if (ch === 104) { // h
      hueStepIdx = (hueStepIdx + 1) % HUE_STEPS.length;
      needsRender = true;
    }
    if (ch === 114) { // r
      needsRender = true;
    }
  }

  // Arrow keys: ESC [ A/B/C/D
  if (bytes.length === 3 && bytes[0] === 27 && bytes[1] === 91) {
    const dir = bytes[2]!;
    if (dir === 67) { // right
      themeIdx = (themeIdx + 1) % themes.length;
      needsRender = true;
    }
    if (dir === 68) { // left
      themeIdx = (themeIdx - 1 + themes.length) % themes.length;
      needsRender = true;
    }
    if (dir === 65) { // up
      sampleIdx = (sampleIdx + 1) % MOCK_SAMPLES.length;
      needsRender = true;
    }
    if (dir === 66) { // down
      sampleIdx = (sampleIdx - 1 + MOCK_SAMPLES.length) % MOCK_SAMPLES.length;
      needsRender = true;
    }
  }
}

// --- Lifecycle ---

function cleanup(): void {
  process.stdout.write("\x1b[?25h"); // show cursor
  process.stdout.write("\x1b[?1049l"); // leave alt screen
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

function main(): void {
  // Enter alt screen + hide cursor
  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l");

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleInput);

  // Re-render on terminal resize
  process.stdout.on("resize", () => {
    needsRender = true;
  });

  // Render loop — only redraws when state changes
  const frame = (): void => {
    if (needsRender) {
      needsRender = false;
      render();
    }
    setTimeout(frame, 50); // 20 Hz poll
  };
  frame();

  // Safety: restore terminal on uncaught errors
  process.on("uncaughtException", (err) => {
    cleanup();
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

main();
