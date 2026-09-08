import os from "node:os";
import path from "node:path";

// [LAW:one-source-of-truth] Spelled once so both writers mean the same file.
export function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}
