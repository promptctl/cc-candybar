import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_CONFIG } from "./defaults";
import { configDir } from "../daemon/paths";
import type { ColorTheme } from "../themes";
import { listAvailableThemes } from "../themes/cascade.js";
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
} from "../segments/renderer";
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
  };
}

export interface DisplayConfig {
  lines: LineConfig[];
  style?: "minimal" | "powerline" | "capsule";
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

const VALID_THEMES = new Set<string>([...listAvailableThemes()]);

function isValidTheme(theme: string): boolean {
  return VALID_THEMES.has(theme);
}

function isValidStyle(
  style: string,
): style is "minimal" | "powerline" | "capsule" {
  return (
    style === "minimal" ||
    style === "powerline" ||
    style === "capsule"
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
// [LAW:dataflow-not-control-flow] Numeric path segments produce arrays;
// non-numeric produce objects. Same loop, branch driven by the next key's
// shape — lets dotted CLI overrides like `actions.0.verb` build arrays
// without a separate array-aware path syntax.
const isArrayIndex = (s: string): boolean => /^(0|[1-9][0-9]*)$/.test(s);

function writeAtPath(root: any, path: string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = isArrayIndex(path[i + 1]!) ? [] : {};
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
        writeResolved(
          config,
          `display.${key}`,
          parseSetValue(pair.slice(eq + 1)),
        );
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

  applyOverrideFlags(config, args);

  // [LAW:dataflow-not-control-flow] --toolbar 'EXPR' parses the inline DSL
  // into ToolbarItem[] and writes it onto every line that already has a
  // toolbar segment in the layout. The DSL is the source of truth for items.
  const toolbarArg = getArgValue(args, "--toolbar");
  if (toolbarArg !== undefined) {
    const items = parseToolbarDsl(toolbarArg);
    let attached = false;
    for (const line of config.display.lines) {
      if (line.segments.toolbar) {
        line.segments.toolbar.items = items;
        line.segments.toolbar.enabled = true;
        attached = true;
      }
    }
    if (!attached) {
      process.stderr.write(
        `Warning: --toolbar provided but no "toolbar" segment in layout (use --layout '... toolbar ...').\n`,
      );
    }
  }

  return { config, configFilePath: configFile };
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
  applyOverrideFlags(config, args);
  const toolbarArg = getArgValue(args, "--toolbar");
  if (toolbarArg !== undefined) {
    const items = parseToolbarDsl(toolbarArg);
    for (const line of config.display.lines) {
      if (line.segments.toolbar) {
        line.segments.toolbar.items = items;
        line.segments.toolbar.enabled = true;
      }
    }
  }
  return config;
}

export const loadConfigFromCLI = loadConfig;
