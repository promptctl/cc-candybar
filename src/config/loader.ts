import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PowerlineConfig, ConfigLoadOptions } from "../types/config";
import { DEFAULT_CONFIG } from "./defaults";

function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>
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
          targetValue as Record<string, any>,
          sourceValue as Record<string, any>
        ) as T[Extract<keyof T, string>];
      } else if (Array.isArray(sourceValue) && sourceValue.length === 0) {
        const targetValue = result[key];
        if (!Array.isArray(targetValue) || targetValue.length > 0) {
          continue;
        } else {
          result[key] = sourceValue as T[Extract<keyof T, string>];
        }
      } else {
        result[key] = sourceValue as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

function findConfigFile(
  customPath?: string,
  projectDir?: string
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
      `Failed to load config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function loadEnvConfig(): Partial<PowerlineConfig> {
  const config: Partial<PowerlineConfig> = {};

  if (process.env.CLAUDE_POWERLINE_THEME) {
    config.theme = process.env.CLAUDE_POWERLINE_THEME as
      | "light"
      | "dark"
      | "custom";
  }

  if (process.env.CLAUDE_POWERLINE_STYLE) {
    if (!config.display) {
      config.display = { lines: [] };
    }
    const style = process.env.CLAUDE_POWERLINE_STYLE;
    if (style === "minimal" || style === "powerline") {
      config.display.style = style;
    } else {
      console.warn(
        `Invalid display style '${style}' from environment variable, falling back to 'minimal'`
      );
      config.display.style = "minimal";
    }
  }

  if (process.env.CLAUDE_POWERLINE_USAGE_TYPE) {
    const usageType = process.env.CLAUDE_POWERLINE_USAGE_TYPE as
      | "cost"
      | "tokens"
      | "both"
      | "breakdown";
    if (["cost", "tokens", "both", "breakdown"].includes(usageType)) {
      config.usageType = usageType;
    }
  }

  return config;
}

function getConfigPathFromEnv(): string | undefined {
  return process.env.CLAUDE_POWERLINE_CONFIG;
}

function parseCLIOverrides(args: string[]): Partial<PowerlineConfig> {
  const config: Partial<PowerlineConfig> = {};

  const themeIndex = args.findIndex((arg) => arg.startsWith("--theme="));
  if (themeIndex !== -1) {
    const theme = args[themeIndex]?.split("=")[1];
    if (theme) {
      config.theme = theme as "light" | "dark" | "custom";
    }
  }

  const styleIndex = args.findIndex((arg) => arg.startsWith("--style="));
  if (styleIndex !== -1) {
    const style = args[styleIndex]?.split("=")[1];
    if (style) {
      if (!config.display) {
        config.display = { lines: [] };
      }
      if (style === "minimal" || style === "powerline") {
        config.display.style = style;
      } else {
        console.warn(
          `Invalid display style '${style}' from CLI argument, falling back to 'minimal'`
        );
        config.display.style = "minimal";
      }
    }
  }

  const dailyBudgetIndex = args.findIndex((arg) =>
    arg.startsWith("--daily-budget=")
  );
  if (dailyBudgetIndex !== -1) {
    const dailyBudget = parseFloat(args[dailyBudgetIndex]?.split("=")[1] || "");
    if (!isNaN(dailyBudget) && dailyBudget > 0) {
      config.budget = {
        ...config.budget,
        today: {
          ...DEFAULT_CONFIG.budget?.today,
          amount: dailyBudget,
        },
      };
    }
  }

  const sessionBudgetIndex = args.findIndex((arg) =>
    arg.startsWith("--session-budget=")
  );
  if (sessionBudgetIndex !== -1) {
    const sessionBudget = parseFloat(
      args[sessionBudgetIndex]?.split("=")[1] || ""
    );
    if (!isNaN(sessionBudget) && sessionBudget > 0) {
      config.budget = {
        ...config.budget,
        session: {
          ...DEFAULT_CONFIG.budget?.session,
          amount: sessionBudget,
        },
      };
    }
  }

  const usageIndex = args.findIndex((arg) => arg.startsWith("--usage="));
  if (usageIndex !== -1) {
    const usageType = args[usageIndex]?.split("=")[1] as
      | "cost"
      | "tokens"
      | "both"
      | "breakdown";
    if (
      usageType &&
      ["cost", "tokens", "both", "breakdown"].includes(usageType)
    ) {
      config.usageType = usageType;
    }
  }

  return config;
}

export function loadConfig(options: ConfigLoadOptions = {}): PowerlineConfig {
  const {
    configPath,
    ignoreEnvVars = false,
    cliOverrides = {},
    projectDir,
  } = options;

  let config: PowerlineConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  const configFile = findConfigFile(configPath, projectDir);
  if (configFile) {
    try {
      const fileConfig = loadConfigFile(configFile);
      config = deepMerge(config, fileConfig);
    } catch (err) {
      console.warn(
        `Warning: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (
    config.display?.style &&
    config.display.style !== "minimal" &&
    config.display.style !== "powerline"
  ) {
    console.warn(
      `Invalid display style '${config.display.style}' in config file, falling back to 'minimal'`
    );
    config.display.style = "minimal";
  }

  if (!ignoreEnvVars) {
    const envConfig = loadEnvConfig();
    config = deepMerge(config, envConfig);
  }

  config = deepMerge(config, cliOverrides);

  if (config.usageType) {
    config.display.lines.forEach((line) => {
      if (line.segments.session) {
        line.segments.session.type = config.usageType!;
      }
      if (line.segments.today) {
        line.segments.today.type = config.usageType!;
      }
      if (line.segments.block) {
        line.segments.block.type =
          config.usageType === "breakdown" || config.usageType === "both"
            ? "cost"
            : config.usageType!;
      }
    });
    delete config.usageType;
  }

  return config;
}

export function loadConfigFromCLI(
  args: string[] = process.argv,
  projectDir?: string
): PowerlineConfig {
  const configPathIndex = args.findIndex((arg) => arg.startsWith("--config="));
  const configPath =
    configPathIndex !== -1
      ? args[configPathIndex]?.split("=")[1]
      : getConfigPathFromEnv();

  const cliOverrides = parseCLIOverrides(args);

  return loadConfig({ configPath, cliOverrides, projectDir });
}

export function getConfigPath(
  customPath?: string,
  projectDir?: string
): string | null {
  return findConfigFile(customPath, projectDir);
}
