import { debug } from "./logger";
import { readFileSync } from "fs";

export interface ContextInfo {
  inputTokens: number;
  percentage: number;
  usablePercentage: number;
  contextLeftPercentage: number;
  maxTokens: number;
  usableTokens: number;
}

interface ContextUsageThresholds {
  LOW: number;
  MEDIUM: number;
}

interface TranscriptEntry {
  message?: {
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  isSidechain?: boolean;
  timestamp?: string;
}

export class ContextProvider {
  private readonly thresholds: ContextUsageThresholds = {
    LOW: 50,
    MEDIUM: 80,
  };

  getContextUsageThresholds(): ContextUsageThresholds {
    return this.thresholds;
  }

  private getContextLimit(_modelId: string): number {
    return 200000;
  }

  calculateContextTokens(
    transcriptPath: string,
    modelId?: string
  ): ContextInfo | null {
    try {
      debug(`Calculating context tokens from transcript: ${transcriptPath}`);

      const content = readFileSync(transcriptPath, "utf-8");
      if (!content) {
        debug("Transcript file is empty");
        return null;
      }

      const lines = content.trim().split("\n");
      if (lines.length === 0) {
        debug("No lines in transcript");
        return null;
      }

      let mostRecentEntry: TranscriptEntry | null = null;
      let mostRecentTime = 0;

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry: TranscriptEntry = JSON.parse(line);

          if (!entry.message?.usage?.input_tokens) continue;

          if (entry.isSidechain === true) continue;

          if (!entry.timestamp) continue;

          const entryTime = new Date(entry.timestamp).getTime();
          if (entryTime > mostRecentTime) {
            mostRecentTime = entryTime;
            mostRecentEntry = entry;
          }
        } catch {}
      }

      if (mostRecentEntry?.message?.usage) {
        const usage = mostRecentEntry.message.usage;
        const contextLength =
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0);

        const contextLimit = modelId ? this.getContextLimit(modelId) : 200000;

        debug(
          `Most recent main chain context: ${contextLength} tokens (limit: ${contextLimit})`
        );

        const percentage = Math.min(
          100,
          Math.max(0, Math.round((contextLength / contextLimit) * 100))
        );

        const usableLimit = Math.round(contextLimit * 0.8);
        const usablePercentage = Math.min(
          100,
          Math.max(0, Math.round((contextLength / usableLimit) * 100))
        );

        const contextLeftPercentage = Math.max(0, 100 - usablePercentage);

        return {
          inputTokens: contextLength,
          percentage,
          usablePercentage,
          contextLeftPercentage,
          maxTokens: contextLimit,
          usableTokens: usableLimit,
        };
      }

      debug("No main chain entries with usage data found");
      return null;
    } catch (error) {
      debug(
        `Error reading transcript: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }
}
