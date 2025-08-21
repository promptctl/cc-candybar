import { exec } from "node:child_process";
import { promisify } from "node:util";
import { debug } from "../utils/logger";

const execAsync = promisify(exec);

export interface VersionInfo {
  version: string | null;
}

export class VersionProvider {
  async getClaudeVersion(): Promise<string | null> {
    try {
      const result = await execAsync("claude --version", {
        encoding: "utf8",
        timeout: 1000,
      });
      const output = result.stdout.trim();

      const match = output.match(/^([\d.]+)/);
      if (match) {
        const version = `v${match[1]}`;
        debug(`Claude Code version: ${version}`);
        return version;
      }

      debug(`Could not parse version from: ${output}`);
      return null;
    } catch (error) {
      debug(`Error getting Claude Code version:`, error);
      return null;
    }
  }

  async getVersionInfo(): Promise<VersionInfo> {
    const version = await this.getClaudeVersion();
    return { version };
  }
}
