import path from "node:path";
import type { JsonValue } from "./var-system/types.js";

// [LAW:one-source-of-truth] The variable that moves Claude Code's
// configuration directory. Mirrored by the Rust client
// (rust-client/src/main.rs, CLAUDE_CONFIG_DIR_ENV) and diffed by
// scripts/check-protocol.mjs, which anchors on the declaration below — keep it
// a named const holding a string literal, or repoint the CHECKS row in the
// same commit.
export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

// [LAW:single-enforcer] Only the statusline CLIENT can observe this: Claude
// Code spawns it with Claude Code's exact environment and working directory,
// while the daemon is detached and one-per-user, its env and cwd answering for
// whichever session spawned it. So the client resolves the directory — the
// variable's first entry, made absolute against the client's own cwd — and
// reports it
// as the `claudeConfigDir` hint, exactly the move `configEnv` made
// (brandon-config-5g8). Mirrored by the Rust client
// (detect_claude_config_dir). Total over the environment: unset or empty is
// `undefined`, the default directory.
export function detectClaudeConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string | undefined {
  const first = (env[CLAUDE_CONFIG_DIR_ENV] ?? "").split(",")[0]!.trim();
  return first === "" ? undefined : path.resolve(cwd, first);
}

// Claude Code's configuration directory: the one a client detected, else the
// default, ~/.claude.
export function claudeConfigDir(
  detected: string | undefined,
  home: string,
): string {
  return detected ?? path.join(home, ".claude");
}

// [LAW:one-source-of-truth] The settings file read by the bar and edited by install.
export function claudeSettingsPath(configDir: string): string {
  return path.join(configDir, "settings.json");
}

// [LAW:types-are-the-program] A settings document as JSON parsed it: JSON
// values all the way down, so a reading of it crosses a process as it is.
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// A JSON object — the shape the document and each of its sections (`env`,
// `statusLine`) must have for a key to be read or spliced inside it.
export const isJsonObject = (
  value: JsonValue | undefined,
): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
