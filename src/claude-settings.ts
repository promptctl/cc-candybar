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

// [LAW:one-source-of-truth] THE location of Claude Code's user settings file
// in a configuration directory. Two writers touch it, both splicing through
// one editor so neither drops the other's keys — `cc-candybar install` (the
// statusLine command) and the doctor's claude-settings fixes (`env`; and
// `statusLine.refreshInterval` when this file is where the statusLine comes
// from, `readSettingsChain`) — and one more reader, the auto-compact window the bar
// shows (src/segments/autocompact.ts), which Claude Code's own `/autocompact`
// writes here. They must all mean the file Claude Code reads, so the path is
// spelled once and imported by each.
export function claudeSettingsPath(configDir: string): string {
  return path.join(configDir, "settings.json");
}

// Where an administrator's managed settings live (code.claude.com/docs/en/
// managed-settings) — fixed system paths, which CLAUDE_CONFIG_DIR does not
// move.
export function claudeManagedSettingsDir(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode";
    case "win32":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return "/etc/claude-code";
  }
}

// [LAW:one-source-of-truth] The managed settings directory a daemon reads,
// under the environment it was handed: test setup moves it so no test reads
// the host's policy.
export const claudeManagedSettingsDirIn = (
  env: Readonly<Record<string, string | undefined>>,
): string =>
  env.CC_CANDYBAR_CLAUDE_MANAGED_DIR ??
  claudeManagedSettingsDir(process.platform);

// The project-local settings file: the user's own, beside the project's
// shared `.claude/settings.json` and over it.
export const projectLocalSettingsFile = (projectDir: string): string =>
  path.join(projectDir, ".claude", "settings.local.json");

// The scopes of Claude Code's settings files, highest precedence first.
// `--settings`, MDM policy and server-managed settings are scopes too, but
// none is a file this machine can read, so none is one of these.
export type SettingsScope = "managed" | "project-local" | "project" | "user";

// Where a session's settings chain is read: the managed directory, the
// session's primary working directory (Claude Code reads both project files
// there), and its user settings file.
export interface SettingsChainAt {
  readonly managedDir: string;
  readonly projectDir: string;
  readonly userFile: string;
}

export interface SettingsSource {
  readonly scope: SettingsScope;
  readonly path: string;
  readonly settings: JsonObject;
  // The file's `env`, read as Claude Code merges it: an object, `{}` when
  // the file sets none.
  readonly env: JsonObject;
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
