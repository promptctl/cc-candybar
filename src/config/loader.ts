import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_CONFIG } from "./defaults";
import { configDir } from "../daemon/paths";
import type { ColorTheme } from "../themes";
import { listAvailableThemes, listThemeAliases } from "../themes/cascade.js";
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
  ToolbarSegmentConfig,
  TraySegmentConfig,
} from "../segments/renderer";
import type { AnySegmentConfig } from "../segments/renderer";
import { parseToolbarDsl } from "../segments/renderer";

export interface LineConfig {
  segments: {
    directory?: DirectorySegmentConfig;
    git?: GitSegmentConfig;
    gitTaculous?: GitSegmentConfig;
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
    toolbar?: ToolbarSegmentConfig;
    tray?: TraySegmentConfig;
  };
}

export interface DisplayConfig {
  lines: LineConfig[];
  style?: "minimal" | "powerline" | "capsule" | "random";
  charset?: "unicode" | "text";
  colorCompatibility?: "auto" | "ansi" | "ansi256" | "truecolor";
  autoWrap?: boolean;
  padding?: number;
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

export interface SegmentColorOverride {
  bg?: string;
  fg?: string;
  hue?: number;
  palette?: string;
}

export interface PanelItemConfig {
  text: string;
  verb: string;
  expr: string;
  scheme?: string;
}

export interface PanelConfig {
  items: PanelItemConfig[];
  separator?: string;
}

export interface PowerlineConfig {
  theme: string;
  style?: string;
  display: DisplayConfig;
  colors?: {
    custom: ColorTheme;
  };
  themeMapping?: Record<string, SegmentColorOverride>;
  hueStep?: number;
  panel?: PanelConfig;
  budget?: BudgetConfig;
  modelContextLimits?: Record<string, number>;
}

// [LAW:types-are-the-program] "random" is a sentinel that validators admit
// and resolveSession{Theme,Style,DisplayStyle} expand per-session at render.
const VALID_THEMES = new Set<string>([
  ...listAvailableThemes(),
  ...listThemeAliases(),
  "random",
]);

function isValidTheme(theme: string): boolean {
  return VALID_THEMES.has(theme);
}

function isValidStyle(
  style: string,
): style is "minimal" | "powerline" | "capsule" | "random" {
  return (
    style === "minimal" ||
    style === "powerline" ||
    style === "capsule" ||
    style === "random"
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

// Resolve the config-file path the daemon should watch for live-reload, given
// the same args/projectDir/cwd inputs as loadConfigStrict. Use this when you
// need the path *without* loading (e.g. to keep watching a file even after a
// parse error).
export function resolveConfigPathFromArgs(
  args: string[],
  projectDir?: string,
  cwd?: string,
): string | null {
  const rawConfigPath = getArgValue(args, "--config") || getConfigPathFromEnv();
  const configPath = rawConfigPath?.startsWith("~")
    ? rawConfigPath.replace("~", os.homedir())
    : rawConfigPath;
  return findConfigFile(configPath, projectDir, cwd);
}

export function findConfigFile(
  customPath?: string,
  projectDir?: string,
  cwd?: string,
): string | null {
  if (customPath) {
    return fs.existsSync(customPath) ? customPath : null;
  }

  // [LAW:dataflow-not-control-flow] cwd flows in as a value rather than being
  // read from process.cwd(). The daemon's process cwd is meaningless to the
  // request — only the *requester's* cwd matters. Callers thread the right
  // value through (inline: process.cwd(); daemon: req.cwd from the wire).
  const effectiveCwd = cwd ?? process.cwd();

  const locations = [
    ...(projectDir ? [path.join(projectDir, ".cc-candybar.json")] : []),
    path.join(effectiveCwd, ".cc-candybar.json"),
    path.join(configDir(), "config.json"),
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

  const theme = process.env.CC_CANDYBAR_THEME;
  if (theme && isValidTheme(theme)) {
    config.theme = theme;
  }

  const style = process.env.CC_CANDYBAR_STYLE;
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
  return process.env.CC_CANDYBAR_CONFIG;
}

type SegmentName = keyof LineConfig["segments"];

const VALID_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  "directory",
  "git",
  "gitTaculous",
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
  "toolbar",
  "tray",
]);

function parseLayout(raw: string): LineConfig[] {
  // [LAW:one-source-of-truth] seed each segment from DEFAULT_CONFIG so layout
  // doesn't redefine defaults, only references them. Users supply diffs via --set.
  const defaultsByName: Partial<LineConfig["segments"]> = {};
  for (const line of DEFAULT_CONFIG.display.lines) {
    for (const [name, cfg] of Object.entries(line.segments)) {
      if (cfg !== undefined) {
        (defaultsByName as Record<string, AnySegmentConfig>)[name] = cfg;
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
      (segments as Record<string, AnySegmentConfig>)[name] = cloned;
    }
    return { segments };
  });
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

// [LAW:no-silent-fallbacks] JSON parse failures throw so the daemon can
// surface them to the user instead of silently degrading to defaults.
// `configFilePath` is the resolved config location (or null), so the daemon
// can watch it for live-reload. Cosmetic clamps (invalid theme/style/charset
// names) still warn-and-fallback — those don't destroy the user's intent,
// parse errors do.
export function loadConfigStrict(
  args: string[] = process.argv,
  projectDir?: string,
  cwd?: string,
): { config: PowerlineConfig; configFilePath: string | null } {
  let config: PowerlineConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  const rawConfigPath = getArgValue(args, "--config") || getConfigPathFromEnv();
  const configPath = rawConfigPath?.startsWith("~")
    ? rawConfigPath.replace("~", os.homedir())
    : rawConfigPath;

  const configFile = findConfigFile(configPath, projectDir, cwd);
  if (configFile) {
    const fileConfig = loadConfigFile(configFile);
    config = deepMerge(config, fileConfig);
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

  // [LAW:dataflow-not-control-flow] --toolbar / --tray 'EXPR' parse the same
  // inline DSL (item shape is identical) and write onto the corresponding
  // segment in the layout. The DSL is the source of truth for items.
  attachInlineDslItems(config, args, "--toolbar", "toolbar");
  attachInlineDslItems(config, args, "--tray", "tray");

  return { config, configFilePath: configFile };
}

function attachInlineDslItems(
  config: PowerlineConfig,
  args: string[],
  flag: "--toolbar" | "--tray",
  segmentName: "toolbar" | "tray",
): void {
  const raw = getArgValue(args, flag);
  if (raw === undefined) return;
  const items = parseToolbarDsl(raw);
  let attached = false;
  for (const line of config.display.lines) {
    const segs = line.segments;
    const existing = segs[segmentName];
    if (existing) {
      existing.items = items;
      existing.enabled = true;
      attached = true;
    }
  }
  if (!attached) {
    process.stderr.write(
      `Warning: ${flag} provided but no "${segmentName}" segment in layout (use --layout '... ${segmentName} ...').\n`,
    );
  }
}

// Legacy CLI-path entry point — swallows parse errors as warnings and degrades
// to defaults (preserving prior behavior for non-daemon callers).
export function loadConfig(
  args: string[] = process.argv,
  projectDir?: string,
  cwd?: string,
): PowerlineConfig {
  try {
    return loadConfigStrict(args, projectDir, cwd).config;
  } catch (err) {
    console.warn(
      `Warning: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Re-run without the failing file by passing a path that won't exist.
    // Simpler: replicate the no-file branch directly.
    return loadConfigStrictNoFile(args);
  }
}

// Fallback path used only when loadConfigStrict threw on the file. Skips file
// resolution entirely so we never re-throw on the same input.
function loadConfigStrictNoFile(args: string[]): PowerlineConfig {
  let config: PowerlineConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const envConfig = loadEnvConfig();
  config = deepMerge(config, envConfig);
  const cliOverrides = parseCLIOverrides(args);
  config = deepMerge(config, cliOverrides);
  const layoutArg = getArgValue(args, "--layout");
  if (layoutArg !== undefined) {
    config.display.lines = parseLayout(layoutArg);
  }
  attachInlineDslItems(config, args, "--toolbar", "toolbar");
  attachInlineDslItems(config, args, "--tray", "tray");
  return config;
}

export const loadConfigFromCLI = loadConfig;
