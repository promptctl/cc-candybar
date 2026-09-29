import os from "node:os";
import path from "node:path";

// [LAW:one-source-of-truth] THE location of Claude Code's user settings file.
// Two writers touch it — `cc-candybar install` (the statusLine command) and the
// doctor's claude-settings-env fix (src/doctor/edge.ts) — and they must mean
// the same file, so the path is spelled once and imported by both.
export function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

// Claude Code's record of the plugins installed for this user — where each
// one's files live, at which scope. Read to find the memento plugin
// (src/memento/edge.ts), whose context ceiling the bar shows and moves. Under
// `CLAUDE_CONFIG_DIR` when Claude Code runs with one (its first entry — the
// transcript search in src/utils/claude.ts reads the same variable).
export function claudeInstalledPluginsPath(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  return path.join(
    configured || path.join(os.homedir(), ".claude"),
    "plugins",
    "installed_plugins.json",
  );
}
