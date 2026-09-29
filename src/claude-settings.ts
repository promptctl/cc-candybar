import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSON_DIALECT } from "./config/json5-edit.js";

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
// variable's first entry (the transcript search in src/utils/claude.ts reads
// the same list), made absolute against the client's own cwd — and reports it
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
export function claudeConfigDir(detected: string | undefined): string {
  return detected ?? path.join(os.homedir(), ".claude");
}

// [LAW:one-source-of-truth] THE location of Claude Code's user settings file
// in a configuration directory. Two writers touch it — `cc-candybar install`
// (the statusLine command) and the doctor's claude-settings-env fix
// (src/doctor/edge.ts) — and one more reader, the auto-compact window the bar
// shows (src/segments/autocompact.ts), which Claude Code's own `/autocompact`
// writes here. They must all mean the file Claude Code reads, so the path is
// spelled once and imported by each.
export function claudeSettingsPath(configDir: string): string {
  return path.join(configDir, "settings.json");
}

// Claude Code's record of the plugins installed for this user — where each
// one's files live, at which scope. Read to find the memento plugin
// (src/memento/edge.ts), whose context ceiling the bar shows and moves.
export function claudeInstalledPluginsPath(configDir: string): string {
  return path.join(configDir, "plugins", "installed_plugins.json");
}

// The settings file's bytes, for an editor that splices it. A missing file is
// the one absence with a meaning — Claude Code has written nothing yet — so it
// reads as the empty document.
export function readClaudeSettingsText(settingsPath: string): string {
  return fs.existsSync(settingsPath)
    ? fs.readFileSync(settingsPath, "utf8")
    : "";
}

// [LAW:one-source-of-truth] The ONE reading of Claude Code's settings as a
// document, shared by every reader of its fields (the doctor's `env`, the
// auto-compact window), so no two of them disagree about what a file means.
// Empty text — a missing file or a blank one — is the empty document; text
// that does not parse, or parses to anything but an object, throws naming the
// file ([LAW:no-silent-failure]: Claude Code is not running with whatever a
// guess would say).
export function readClaudeSettings(
  settingsPath: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    const text = readClaudeSettingsText(settingsPath);
    if (/^\s*$/.test(text)) return {};
    parsed = JSON_DIALECT.parse(text);
  } catch (e) {
    throw new Error(`cannot read ${settingsPath}: ${messageOf(e)}`, {
      cause: e,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`cannot read ${settingsPath}: not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
