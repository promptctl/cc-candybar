import os from "node:os";
import path from "node:path";

// [LAW:one-source-of-truth] THE location of Claude Code's user settings file.
// Two writers touch it — `cc-candybar install` (the statusLine command) and the
// doctor's claude-settings-env fix (src/doctor/edge.ts) — and they must mean
// the same file, so the path is spelled once and imported by both.
export function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}
