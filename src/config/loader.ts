import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_CONFIG } from "./defaults";
import type { ColorTheme } from "../themes";
import type { TuiGridConfig } from "../tui/types";
import { isValidSegmentRef } from "../tui/types";
import { BOX_PRESETS } from "../utils/constants";
import type {
  SegmentConfig,
  DirectorySegmentConfig,
  GitSegmentConfig,
  UsageSegmentConfig,
  TmuxSegmentConfig,
  ContextSegmentConfig,
  MetricsSegmentConfig,
  BlockSegmentConfig,
  TodaySegmentConfig,
  VersionSegmentConfig,
  SessionIdSegmentConfig,
  EnvSegmentConfig,
  WeeklySegmentConfig,
} from "../segments/renderer";

export interface LineConfig {
  segments: {
    directory?: DirectorySegmentConfig;
    git?: GitSegmentConfig;
    model?: SegmentConfig;
    session?: UsageSegmentConfig;
    block?: BlockSegmentConfig;
    today?: TodaySegmentConfig;
    tmux?: TmuxSegmentConfig;
    context?: ContextSegmentConfig;
    metrics?: MetricsSegmentConfig;
    version?: VersionSegmentConfig;
    sessionId?: SessionIdSegmentConfig;
    env?: EnvSegmentConfig;
    weekly?: WeeklySegmentConfig;
  };
}

export interface DisplayConfig {
  lines: LineConfig[];
  style?: "minimal" | "powerline" | "capsule" | "tui";
  charset?: "unicode" | "text";
  colorCompatibility?: "auto" | "ansi" | "ansi256" | "truecolor";
  autoWrap?: boolean;
  padding?: number;
  tui?: TuiGridConfig;
}

export interface BudgetItemConfig {
  amount?: number;
  warningThreshold?: number;
  type?: "cost" | "tokens";
}

export interface BudgetConfig {
  session?: BudgetItemConfig;
  today?: BudgetItemConfig;
  block?: BudgetItemConfig;
}

export interface PowerlineConfig {
  theme:
    | "light"
    | "dark"
    | "nord"
    | "tokyo-night"
    | "rose-pine"
    | "gruvbox"
    | "custom";
  display: DisplayConfig;
  colors?: {
    custom: ColorTheme;
  };
  budget?: BudgetConfig;
  modelContextLimits?: Record<string, number>;
}

function isValidTheme(theme: string): theme is PowerlineConfig["theme"] {
  return [
    "light",
    "dark",
    "nord",
    "tokyo-night",
    "rose-pine",
    "gruvbox",
    "custom",
  ].includes(theme);
}

function isValidStyle(
  style: string,
): style is "minimal" | "powerline" | "capsule" | "tui" {
  return (
    style === "minimal" ||
    style === "powerline" ||
    style === "capsule" ||
    style === "tui"
  );
}

function isValidCharset(charset: string): charset is "unicode" | "text" {
  return charset === "unicode" || charset === "text";
}

function getArgValue(args: string[], argName: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === argName && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg?.startsWith(`${argName}=`)) {
      return arg.split("=")[1];
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    if (sourceValue !== undefined) {
      if (
        typeof sourceValue === "object" &&
        sourceValue !== null &&
        !Array.isArray(sourceValue)
      ) {
        const targetValue = result[key] || {};
        result[key] = deepMerge(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          targetValue as Record<string, any>,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sourceValue as Record<string, any>,
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = sourceValue as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

function findConfigFile(
  customPath?: string,
  projectDir?: string,
): string | null {
  if (customPath) {
    return fs.existsSync(customPath) ? customPath : null;
  }

  const locations = [
    ...(projectDir ? [path.join(projectDir, ".claude-powerline.json")] : []),
    path.join(process.cwd(), ".claude-powerline.json"),
    path.join(os.homedir(), ".claude", "claude-powerline.json"),
    path.join(os.homedir(), ".config", "claude-powerline", "config.json"),
  ];

  return locations.find(fs.existsSync) || null;
}

function loadConfigFile(filePath: string): Partial<PowerlineConfig> {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to load config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadEnvConfig(): Partial<PowerlineConfig> {
  const config: Partial<PowerlineConfig> = {};
  const display: Partial<DisplayConfig> = {};

  const theme = process.env.CLAUDE_POWERLINE_THEME;
  if (theme && isValidTheme(theme)) {
    config.theme = theme;
  }

  const style = process.env.CLAUDE_POWERLINE_STYLE;
  if (style) {
    if (isValidStyle(style)) {
      display.style = style;
    } else {
      console.warn(
        `Invalid display style '${style}' from environment variable, falling back to 'minimal'`,
      );
      display.style = "minimal";
    }
  }

  if (Object.keys(display).length > 0) {
    config.display = display as DisplayConfig;
  }

  return config;
}

function getConfigPathFromEnv(): string | undefined {
  return process.env.CLAUDE_POWERLINE_CONFIG;
}

type SegmentName = keyof LineConfig["segments"];

const VALID_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  "directory",
  "git",
  "model",
  "session",
  "block",
  "today",
  "tmux",
  "context",
  "metrics",
  "version",
  "sessionId",
  "env",
  "weekly",
]);

function parseLayout(raw: string): LineConfig[] {
  // [LAW:one-source-of-truth] seed each segment from DEFAULT_CONFIG so layout
  // doesn't redefine defaults, only references them. Users supply diffs via --set.
  const defaultsByName: Partial<LineConfig["segments"]> = {};
  for (const line of DEFAULT_CONFIG.display.lines) {
    for (const [name, cfg] of Object.entries(line.segments)) {
      if (cfg !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (defaultsByName as any)[name] = cfg;
      }
    }
  }

  return raw.split("|").map((linePart) => {
    const names = linePart.trim().split(/\s+/).filter(Boolean);
    const segments: LineConfig["segments"] = {};
    for (const name of names) {
      if (!VALID_SEGMENT_NAMES.has(name)) {
        process.stderr.write(
          `Warning: --layout references unknown segment "${name}" (skipped).\n`,
        );
        continue;
      }
      const seed = defaultsByName[name as SegmentName];

      const cloned = seed ? JSON.parse(JSON.stringify(seed)) : {};
      cloned.enabled = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (segments as any)[name] = cloned;
    }
    return { segments };
  });
}

function parseSetValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

const OVERRIDE_FLAGS = ["set", "show", "display", "segment"] as const;
type OverrideFlag = (typeof OVERRIDE_FLAGS)[number];

function* iterateOverrideFlags(
  args: string[],
): Generator<{ kind: OverrideFlag; body: string }> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    for (const kind of OVERRIDE_FLAGS) {
      const flag = `--${kind}`;
      if (arg === flag && i + 1 < args.length) {
        yield { kind, body: args[i + 1]! };
        i++;
        break;
      }
      if (arg.startsWith(`${flag}=`)) {
        yield { kind, body: arg.slice(flag.length + 1) };
        break;
      }
    }
  }
}

interface ResolvedOverride {
  path: string[];
  value: unknown;
}

function resolveOverride(
  rawPath: string,
  value: unknown,
  config: PowerlineConfig,
): ResolvedOverride[] {
  const parts = rawPath.split(".");
  const head = parts[0];

  // segment.<name>.<...> → display.lines[k].segments.<name>.<...>
  if (head === "segment" && parts.length >= 3) {
    const segName = parts[1]!;
    const rest = parts.slice(2);
    const lines = config.display.lines;
    for (let i = 0; i < lines.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const segs = lines[i]!.segments as any;
      if (segs && segs[segName] !== undefined) {
        return [
          {
            path: ["display", "lines", String(i), "segments", segName, ...rest],
            value,
          },
        ];
      }
    }
    process.stderr.write(
      `Warning: --set ${rawPath} but segment "${segName}" is not in the layout (use --layout to include it).\n`,
    );
    return [];
  }

  // color.<name>="#bg/#fg" → bg+fg pair
  if (head === "color" && parts.length === 2) {
    const segName = parts[1]!;
    if (typeof value !== "string" || !value.includes("/")) {
      process.stderr.write(
        `Warning: --set ${rawPath} expects "#bg/#fg" format, got "${String(value)}".\n`,
      );
      return [];
    }
    const slash = value.indexOf("/");
    const bg = value.slice(0, slash);
    const fg = value.slice(slash + 1);
    return [
      { path: ["colors", "custom", segName, "bg"], value: bg },
      { path: ["colors", "custom", segName, "fg"], value: fg },
    ];
  }

  // color.<name>.{bg,fg}=#hex
  if (
    head === "color" &&
    parts.length === 3 &&
    (parts[2] === "bg" || parts[2] === "fg")
  ) {
    return [{ path: ["colors", "custom", parts[1]!, parts[2]!], value }];
  }

  // budget.<name>.<key>
  if (head === "budget" && parts.length === 3) {
    return [{ path: ["budget", parts[1]!, parts[2]!], value }];
  }

  // modelLimit.<name> → modelContextLimits.<name>
  if (head === "modelLimit" && parts.length === 2) {
    return [{ path: ["modelContextLimits", parts[1]!], value }];
  }

  // literal dotted path
  return [{ path: parts, value }];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeAtPath(root: any, path: string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[path[path.length - 1]!] = value;
}

function writeResolved(
  config: PowerlineConfig,
  rawPath: string,
  value: unknown,
): void {
  for (const ov of resolveOverride(rawPath, value, config)) {
    writeAtPath(config, ov.path, ov.value);
  }
}

function splitCsvPairs(body: string): string[] {
  return body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// [LAW:one-type-per-behavior] --set, --show, --display, --segment are all
// sugars for "write a config value via resolveOverride/writeAtPath". This
// single dispatcher walks argv in order so last-in-args wins regardless of
// which flag is used.
function applyOverrideFlags(config: PowerlineConfig, args: string[]): void {
  for (const { kind, body } of iterateOverrideFlags(args)) {
    if (kind === "set") {
      const eq = body.indexOf("=");
      if (eq === -1) {
        writeResolved(config, body, true);
      } else {
        writeResolved(
          config,
          body.slice(0, eq),
          parseSetValue(body.slice(eq + 1)),
        );
      }
      continue;
    }

    if (kind === "show") {
      const eq = body.indexOf("=");
      if (eq <= 0) {
        process.stderr.write(
          `Warning: --show ${body} expects "<segment>=<flag1,flag2,...>" format.\n`,
        );
        continue;
      }
      const segName = body.slice(0, eq);
      for (const flag of splitCsvPairs(body.slice(eq + 1))) {
        const field = `show${flag[0]!.toUpperCase()}${flag.slice(1)}`;
        writeResolved(config, `segment.${segName}.${field}`, true);
      }
      continue;
    }

    if (kind === "display") {
      for (const pair of splitCsvPairs(body)) {
        const eq = pair.indexOf("=");
        if (eq <= 0) {
          process.stderr.write(
            `Warning: --display ${pair} expects "<key>=<value>" (comma-separated for multiple).\n`,
          );
          continue;
        }
        const key = pair.slice(0, eq);
        writeResolved(config, `display.${key}`, parseSetValue(pair.slice(eq + 1)));
      }
      continue;
    }

    if (kind === "segment") {
      for (const pair of splitCsvPairs(body)) {
        const eq = pair.indexOf("=");
        if (eq <= 0 || !pair.slice(0, eq).includes(".")) {
          process.stderr.write(
            `Warning: --segment ${pair} expects "<segName>.<field>=<value>" (comma-separated for multiple).\n`,
          );
          continue;
        }
        const lhs = pair.slice(0, eq);
        writeResolved(
          config,
          `segment.${lhs}`,
          parseSetValue(pair.slice(eq + 1)),
        );
      }
      continue;
    }
  }
}

function parseCLIOverrides(args: string[]): Partial<PowerlineConfig> {
  const config: Partial<PowerlineConfig> = {};
  const display: Partial<DisplayConfig> = {};

  const theme = getArgValue(args, "--theme");
  if (theme && isValidTheme(theme)) {
    config.theme = theme;
  }

  const style = getArgValue(args, "--style");
  if (style) {
    if (isValidStyle(style)) {
      display.style = style;
    } else {
      console.warn(
        `Invalid display style '${style}' from CLI argument, falling back to 'minimal'`,
      );
      display.style = "minimal";
    }
  }

  const charset = getArgValue(args, "--charset");
  if (charset) {
    if (isValidCharset(charset)) {
      display.charset = charset;
    } else {
      console.warn(
        `Invalid charset '${charset}' from CLI argument, falling back to 'unicode'`,
      );
      display.charset = "unicode";
    }
  }

  if (Object.keys(display).length > 0) {
    config.display = display as DisplayConfig;
  }

  return config;
}

function validateGridConfig(tui: TuiGridConfig): string | null {
  if (typeof tui.box === "string" && !BOX_PRESETS[tui.box]) {
    const valid = Object.keys(BOX_PRESETS).join(", ");
    return `unknown box preset "${tui.box}" (valid: ${valid})`;
  }

  if (
    !tui.breakpoints ||
    !Array.isArray(tui.breakpoints) ||
    tui.breakpoints.length === 0
  ) {
    return "grid config must have at least one breakpoint";
  }

  const seenMinWidths = new Set<number>();
  for (let bpIdx = 0; bpIdx < tui.breakpoints.length; bpIdx++) {
    const bp = tui.breakpoints[bpIdx]!;
    const prefix = `breakpoint[${bpIdx}]`;

    if (typeof bp.minWidth !== "number" || bp.minWidth < 0) {
      return `${prefix}: minWidth must be a non-negative number`;
    }

    if (seenMinWidths.has(bp.minWidth)) {
      return `${prefix}: duplicate minWidth ${bp.minWidth} (each breakpoint must have a unique minWidth)`;
    }
    seenMinWidths.add(bp.minWidth);

    if (!bp.areas || !Array.isArray(bp.areas) || bp.areas.length === 0) {
      return `${prefix}: areas must be a non-empty array of strings`;
    }

    if (!bp.columns || !Array.isArray(bp.columns) || bp.columns.length === 0) {
      return `${prefix}: columns must be a non-empty array`;
    }

    const colCount = bp.columns.length;

    // Validate column definitions
    for (const col of bp.columns) {
      if (typeof col !== "string") {
        return `${prefix}: column definition must be a string`;
      }
      if (!/^(\d+fr|\d+|auto)$/.test(col)) {
        return `${prefix}: invalid column definition "${col}" (use "auto", "Nfr", or a fixed integer)`;
      }
    }

    // Validate align array
    if (bp.align !== undefined) {
      if (!Array.isArray(bp.align)) {
        return `${prefix}: align must be an array`;
      }
      if (bp.align.length !== colCount) {
        return `${prefix}: align length (${bp.align.length}) must match columns length (${colCount})`;
      }
      for (const a of bp.align) {
        if (a !== "left" && a !== "center" && a !== "right") {
          return `${prefix}: invalid align value "${a}"`;
        }
      }
    }

    // Validate areas rows
    const seenSegments = new Set<string>();
    for (let rowIdx = 0; rowIdx < bp.areas.length; rowIdx++) {
      const row = bp.areas[rowIdx]!;

      // Divider row
      if (row.trim() === "---") continue;

      const cells = row.trim().split(/\s+/);
      if (cells.length !== colCount) {
        return `${prefix}: row "${row}" has ${cells.length} cells but expected ${colCount} columns`;
      }

      // Check segment names and contiguity
      const templateNames = tui.segments
        ? new Set(Object.keys(tui.segments))
        : new Set<string>();
      let prevCell = "";
      let spanName = "";
      for (const cell of cells) {
        if (cell !== ".") {
          if (!isValidSegmentRef(cell) && !templateNames.has(cell)) {
            return `${prefix}: unknown segment name "${cell}"`;
          }
          // Check for non-contiguous spans
          if (cell === spanName) {
            // still in the same span, ok
          } else if (seenSegments.has(cell)) {
            return `${prefix}: segment "${cell}" appears on multiple rows`;
          }
        }

        // Track span contiguity
        if (cell !== prevCell) {
          if (spanName && prevCell !== spanName && prevCell !== ".") {
            // finished a span
          }
          spanName = cell;
        }
        prevCell = cell;
      }

      // Check for non-contiguous spans within this row
      const seen = new Map<string, number>();
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]!;
        if (cell === "." || cell === "---") continue;
        const lastIdx = seen.get(cell);
        if (lastIdx !== undefined && lastIdx !== i - 1) {
          return `${prefix}: segment "${cell}" has non-contiguous span in row "${row}"`;
        }
        seen.set(cell, i);
      }

      // Record segments from this row
      for (const cell of cells) {
        if (cell !== "." && cell !== "---") {
          seenSegments.add(cell);
        }
      }
    }
  }

  if (tui.segments) {
    for (const [segRef, tmpl] of Object.entries(tui.segments)) {
      if (!tmpl.items || !Array.isArray(tmpl.items)) {
        return `segments["${segRef}"]: items must be an array`;
      }
      if (
        tmpl.justify !== undefined &&
        tmpl.justify !== "start" &&
        tmpl.justify !== "between"
      ) {
        return `segments["${segRef}"]: invalid justify value "${tmpl.justify}" (use "start" or "between")`;
      }
    }
  }

  return null; // valid
}

export function loadConfig(
  args: string[] = process.argv,
  projectDir?: string,
): PowerlineConfig {
  let config: PowerlineConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  const rawConfigPath = getArgValue(args, "--config") || getConfigPathFromEnv();
  const configPath = rawConfigPath?.startsWith("~")
    ? rawConfigPath.replace("~", os.homedir())
    : rawConfigPath;

  const configFile = findConfigFile(configPath, projectDir);
  if (configFile) {
    try {
      const fileConfig = loadConfigFile(configFile);
      config = deepMerge(config, fileConfig);
    } catch (err) {
      console.warn(
        `Warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (config.display?.style && !isValidStyle(config.display.style)) {
    console.warn(
      `Invalid display style '${config.display.style}' in config file, falling back to 'minimal'`,
    );
    config.display.style = "minimal";
  }

  if (config.display?.charset && !isValidCharset(config.display.charset)) {
    console.warn(
      `Invalid charset '${config.display.charset}' in config file, falling back to 'unicode'`,
    );
    config.display.charset = "unicode";
  }

  if (config.theme && !isValidTheme(config.theme)) {
    console.warn(
      `Invalid theme '${config.theme}' in config file, falling back to 'dark'`,
    );
    config.theme = "dark";
  }

  const envConfig = loadEnvConfig();
  config = deepMerge(config, envConfig);

  const cliOverrides = parseCLIOverrides(args);
  config = deepMerge(config, cliOverrides);

  // [LAW:dataflow-not-control-flow] --layout replaces display.lines wholesale
  // (lines[] is an array — deepMerge replaces arrays — so the layout owns
  // structure deterministically). --set then writes values into the resolved
  // structure.
  const layoutArg = getArgValue(args, "--layout");
  if (layoutArg !== undefined) {
    config.display.lines = parseLayout(layoutArg);
  }

  applyOverrideFlags(config, args);

  // Validate grid config if present
  if (config.display?.tui) {
    const error = validateGridConfig(config.display.tui);
    if (error) {
      process.stderr.write(
        `Warning: invalid grid config: ${error}. Falling back to hardcoded layout.\n`,
      );
      delete config.display.tui;
    }
  }

  return config;
}

export const loadConfigFromCLI = loadConfig;
