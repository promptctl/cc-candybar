import process from "node:process";
import { listAvailableThemes } from "../themes/index.js";
import { getThemePalette } from "../themes/palette-registry.js";
import type { ColorRgba } from "rich-js";
import type { SegmentOverride } from "../themes/cascade.js";
import { PowerlineRenderer } from "../powerline.js";
import type { ClaudeHookData } from "../utils/claude.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { PowerlineConfig } from "../config/loader.js";

// --- Mapping presets ---

type MappingPreset = {
  name: string;
  overrides: Record<string, SegmentOverride> | null;
};

const MAPPING_PRESETS: MappingPreset[] = [
  {
    name: "Hue Rotation",
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
    name: "Surface",
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
];

// --- Mock hook data ---

const MOCK_HOOK_SAMPLES: { name: string; data: ClaudeHookData }[] = [
  {
    name: "Default Session",
    data: {
      hook_event_name: "Status",
      session_id: "abc-123-def",
      transcript_path: "/tmp/fake-transcript.jsonl",
      cwd: "/home/user/projects/my-app",
      model: { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4" },
      workspace: {
        current_dir: "/home/user/projects/my-app",
        project_dir: "/home/user/projects/my-app",
      },
      version: "1.0.33",
      cost: {
        total_cost_usd: 2.34,
        total_duration_ms: 180000,
        total_api_duration_ms: 120000,
        total_lines_added: 450,
        total_lines_removed: 120,
      },
      context_window: {
        total_input_tokens: 35000,
        total_output_tokens: 12000,
        context_window_size: 200000,
        used_percentage: 38,
        remaining_percentage: 62,
        current_usage: {
          input_tokens: 30000,
          output_tokens: 12000,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 25000,
        },
      },
    },
  },
  {
    name: "Critical Context",
    data: {
      hook_event_name: "Status",
      session_id: "xyz-789",
      transcript_path: "/tmp/fake-transcript.jsonl",
      cwd: "/home/user/projects/big-monorepo",
      model: { id: "claude-opus-4-7", display_name: "Claude Opus 4" },
      workspace: {
        current_dir: "/home/user/projects/big-monorepo",
        project_dir: "/home/user/projects/big-monorepo",
      },
      cost: {
        total_cost_usd: 45.67,
        total_duration_ms: 600000,
        total_api_duration_ms: 420000,
        total_lines_added: 2300,
        total_lines_removed: 800,
      },
      context_window: {
        total_input_tokens: 175000,
        total_output_tokens: 45000,
        context_window_size: 200000,
        used_percentage: 92,
        remaining_percentage: 8,
        current_usage: {
          input_tokens: 160000,
          output_tokens: 45000,
          cache_creation_input_tokens: 20000,
          cache_read_input_tokens: 140000,
        },
      },
    },
  },
  {
    name: "Heavy Usage",
    data: {
      hook_event_name: "Status",
      session_id: "heavy-456",
      transcript_path: "/tmp/fake-transcript.jsonl",
      cwd: "/home/user/projects/legacy-refactor",
      model: { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4" },
      workspace: {
        current_dir: "/home/user/projects/legacy-refactor",
        project_dir: "/home/user/projects/legacy-refactor",
      },
      version: "1.0.33",
      cost: {
        total_cost_usd: 12.89,
        total_duration_ms: 360000,
        total_api_duration_ms: 280000,
        total_lines_added: 1200,
        total_lines_removed: 450,
      },
      context_window: {
        total_input_tokens: 85000,
        total_output_tokens: 28000,
        context_window_size: 200000,
        used_percentage: 58,
        remaining_percentage: 42,
        current_usage: {
          input_tokens: 75000,
          output_tokens: 28000,
          cache_creation_input_tokens: 15000,
          cache_read_input_tokens: 60000,
        },
      },
    },
  },
];

// --- State ---

const themes = listAvailableThemes().filter((t) => t !== "custom");
const styles = ["powerline", "capsule", "minimal"] as const;

let themeIdx = themes.indexOf("gruvbox");
if (themeIdx === -1) themeIdx = 0;
let sampleIdx = 0;
let styleIdx = 0;
let mappingIdx = 0;
let hueStep = 0;
const HUE_STEP_INCREMENT = 5;
let needsRender = true;

// --- ANSI helpers ---

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BG_DARK = "\x1b[48;5;236m";
const BG_PANEL = "\x1b[48;5;234m";

function colorToHex(c: ColorRgba): string {
  const r = c.red.toString(16).padStart(2, "0");
  const g = c.green.toString(16).padStart(2, "0");
  const b = c.blue.toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

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
    ],
  },
  {
    title: "Core (Button bg)",
    entries: [
      { labels: ["btn-fg", "primary"], fg: "button-color-foreground", bg: "primary" },
      { labels: ["btn-fg", "secondary"], fg: "button-color-foreground", bg: "secondary" },
      { labels: ["btn-fg", "accent"], fg: "button-color-foreground", bg: "accent" },
      { labels: ["btn-fg", "success"], fg: "button-color-foreground", bg: "success" },
      { labels: ["btn-fg", "warning"], fg: "button-color-foreground", bg: "warning" },
      { labels: ["btn-fg", "error"], fg: "button-color-foreground", bg: "error" },
    ],
  },
  {
    title: "Muted (Label bg)",
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
    title: "Surfaces",
    entries: [
      { labels: ["fg", "surface"], fg: "foreground", bg: "surface" },
      { labels: ["fg", "panel"], fg: "foreground", bg: "panel" },
      { labels: ["fg", "surface-active"], fg: "foreground", bg: "surface-active" },
    ],
  },
  {
    title: "Text vars",
    entries: [
      { labels: ["text", "bg"], fg: "text", bg: "background" },
      { labels: ["text-primary", "bg"], fg: "text-primary", bg: "background" },
      { labels: ["text-muted", "bg"], fg: "text-muted", bg: "background" },
      { labels: ["text-success", "bg"], fg: "text-success", bg: "background" },
      { labels: ["text-warning", "bg"], fg: "text-warning", bg: "background" },
      { labels: ["text-error", "bg"], fg: "text-error", bg: "background" },
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

// --- Real powerline rendering ---

function buildConfig(): PowerlineConfig {
  return {
    ...DEFAULT_CONFIG,
    theme: themes[themeIdx]!,
    display: {
      ...DEFAULT_CONFIG.display,
      style: styles[styleIdx]!,
      colorCompatibility: "truecolor",
    },
    themeMapping: MAPPING_PRESETS[mappingIdx]!.overrides ?? undefined,
    hueStep: hueStep || undefined,
  };
}

async function buildRealBar(): Promise<string> {
  const config = buildConfig();
  const renderer = new PowerlineRenderer(config);
  const sample = MOCK_HOOK_SAMPLES[sampleIdx]!;
  return renderer.generateStatusline(sample.data);
}

// --- Main render ---

async function render(): Promise<void> {
  const width = getTerminalWidth();
  const height = getTerminalHeight();
  const innerWidth = width - 2;

  const theme = themes[themeIdx]!;
  const style = styles[styleIdx]!;
  const preset = MAPPING_PRESETS[mappingIdx]!;
  const sample = MOCK_HOOK_SAMPLES[sampleIdx]!;
  const hueLabel = `${hueStep}°`;

  const lines: string[] = [];

  // Title
  const title = ` Claude Powerline Theme Explorer `;
  const titlePad = innerWidth - title.length;
  const titleLeft = Math.floor(titlePad / 2);
  lines.push(
    `${BG_PANEL}${BOLD}${" ".repeat(titleLeft)}${title}${" ".repeat(titlePad - titleLeft)}${RESET}`,
  );
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);

  // Real powerline bar
  const bar = await buildRealBar();
  lines.push(`${BG_DARK} ${bar}${RESET}`);

  // Spacer
  lines.push(`${BG_DARK}${" ".repeat(innerWidth)}${RESET}`);

  // Palette legend header
  lines.push(
    `${BG_PANEL}${BOLD} Palette: ${theme}    Sample: ${sample.name}${RESET}`,
  );

  // Palette legend
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
  const sampleLabel = `Sample: [↑/↓] ${sampleIdx + 1}/${MOCK_HOOK_SAMPLES.length}`;
  const hueLine = `Hue: [,/.] ${hueLabel}`;
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

  if (bytes.length === 1 && bytes[0] === 3) {
    cleanup();
    process.exit(0);
  }

  if (bytes.length === 1) {
    const ch = bytes[0]!;
    if (ch === 113) { cleanup(); process.exit(0); }
    if (ch === 109) { mappingIdx = (mappingIdx + 1) % MAPPING_PRESETS.length; needsRender = true; }
    if (ch === 77) { mappingIdx = (mappingIdx - 1 + MAPPING_PRESETS.length) % MAPPING_PRESETS.length; needsRender = true; }
    if (ch === 115) { styleIdx = (styleIdx + 1) % styles.length; needsRender = true; }
    if (ch === 48) { hueStep = 0; needsRender = true; }
    if (ch === 43 || ch === 93 || ch === 46) { hueStep += HUE_STEP_INCREMENT; needsRender = true; }
    if (ch === 45 || ch === 91 || ch === 44) { hueStep = Math.max(0, hueStep - HUE_STEP_INCREMENT); needsRender = true; }
  }

  if (bytes.length === 3 && bytes[0] === 27 && bytes[1] === 91) {
    const dir = bytes[2]!;
    if (dir === 67) { themeIdx = (themeIdx + 1) % themes.length; needsRender = true; }
    if (dir === 68) { themeIdx = (themeIdx - 1 + themes.length) % themes.length; needsRender = true; }
    if (dir === 65) { sampleIdx = (sampleIdx + 1) % MOCK_HOOK_SAMPLES.length; needsRender = true; }
    if (dir === 66) { sampleIdx = (sampleIdx - 1 + MOCK_HOOK_SAMPLES.length) % MOCK_HOOK_SAMPLES.length; needsRender = true; }
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
      render().catch((err) => {
        process.stderr.write(`Render error: ${err.message}\n`);
      });
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
