import os from "node:os";
import path from "node:path";

// Claude Code's configuration directory: `CLAUDE_CONFIG_DIR` when Claude Code
// runs with one (its first entry — the transcript search in src/utils/claude.ts
// reads the same variable), else ~/.claude.
function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  return configured || path.join(os.homedir(), ".claude");
}

// [LAW:one-source-of-truth] THE location of Claude Code's user settings file.
// Two writers touch it — `cc-candybar install` (the statusLine command) and the
// doctor's claude-settings-env fix (src/doctor/edge.ts) — and one reader, the
// auto-compact window the bar shows (src/segments/autocompact.ts), which
// Claude Code's own `/autocompact` writes here. They must all mean the file
// Claude Code reads, so the path is spelled once and imported by each.
export function claudeSettingsPath(): string {
  return path.join(claudeConfigDir(), "settings.json");
}

// Claude Code's record of the plugins installed for this user — where each
// one's files live, at which scope. Read to find the memento plugin
// (src/memento/edge.ts), whose context ceiling the bar shows and moves.
export function claudeInstalledPluginsPath(): string {
  return path.join(claudeConfigDir(), "plugins", "installed_plugins.json");
}
