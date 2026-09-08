import type { ParsedEntry, ClaudeHookData } from "../utils/claude";

import { debug } from "../utils/logger";
import { parseJsonlFile } from "../utils/claude";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

export interface ContextInfo {
  totalTokens: number;
  percentage: number;
  contextLeftPercentage: number;
  maxTokens: number;
}

interface ContextUsageThresholds {
  LOW: number;
  MEDIUM: number;
}

// [LAW:one-source-of-truth] The window size is NEVER guessed from the model
// name: this is a last-resort floor, not a per-model table, and must not grow.
const DEFAULT_CONTEXT_WINDOW = 200000;

export class ContextProvider {
  private readonly thresholds: ContextUsageThresholds = {
    LOW: 50,
    MEDIUM: 80,
  };

  getContextUsageThresholds(): ContextUsageThresholds {
    return this.thresholds;
  }

  // The fallback ONLY; the natively reported percentages are authoritative.
  private ratioPercentages(
    totalTokens: number,
    contextLimit: number,
  ): Pick<ContextInfo, "percentage" | "contextLeftPercentage"> {
    const percentage = Math.min(
      100,
      Math.max(0, Math.round((totalTokens / contextLimit) * 100)),
    );
    return { percentage, contextLeftPercentage: Math.max(0, 100 - percentage) };
  }

  calculateContextFromHookData(hookData: ClaudeHookData): ContextInfo | null {
    const cw = hookData.context_window;
    if (!cw?.current_usage) {
      debug(
        "No current_usage in hook data, falling back to transcript parsing",
      );
      return null;
    }

    const currentUsage = cw.current_usage;
    // [LAW:no-defensive-null-guards] cw present proves its required size present.
    const contextLimit = cw.context_window_size;
    const totalTokens =
      (currentUsage.input_tokens || 0) +
      (currentUsage.cache_creation_input_tokens || 0) +
      (currentUsage.cache_read_input_tokens || 0);

    debug(
      `Native current_usage: input=${currentUsage.input_tokens}, cache_create=${currentUsage.cache_creation_input_tokens}, cache_read=${currentUsage.cache_read_input_tokens}, total=${totalTokens} (limit: ${contextLimit})`,
    );

    // [LAW:one-source-of-truth] The reported percentages are authoritative.
    const ratio = this.ratioPercentages(totalTokens, contextLimit);
    return {
      totalTokens,
      maxTokens: contextLimit,
      percentage:
        cw.used_percentage != null
          ? Math.round(cw.used_percentage)
          : ratio.percentage,
      contextLeftPercentage:
        cw.remaining_percentage != null
          ? Math.round(cw.remaining_percentage)
          : ratio.contextLeftPercentage,
    };
  }

  /** [LAW:no-silent-failure] Unreadable is `failed`; no usable entry is `absent`. */
  async calculateContextTokensFromTranscript(
    transcriptPath: string,
    contextLimit: number,
  ): Promise<Outcome<ContextInfo>> {
    try {
      debug(`Calculating context tokens from transcript: ${transcriptPath}`);

      const parsedEntries = await parseJsonlFile(transcriptPath);

      if (parsedEntries.length === 0) {
        debug("No entries in transcript");
        return ABSENT;
      }

      let mostRecentEntry: ParsedEntry | null = null;

      for (let i = parsedEntries.length - 1; i >= 0; i--) {
        const entry = parsedEntries[i];
        if (!entry) continue;

        if (!entry.message?.usage?.input_tokens) continue;
        if (entry.isSidechain === true) continue;

        mostRecentEntry = entry;
        debug(
          `Context segment: Found most recent entry at ${entry.timestamp.toISOString()}, stopping search`,
        );
        break;
      }

      if (mostRecentEntry?.message?.usage) {
        const usage = mostRecentEntry.message.usage;
        const totalTokens =
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0);

        debug(
          `Most recent main chain context: ${totalTokens} tokens (limit: ${contextLimit})`,
        );

        return ok({
          totalTokens,
          maxTokens: contextLimit,
          ...this.ratioPercentages(totalTokens, contextLimit),
        });
      }

      debug("No main chain entries with usage data found");
      return ABSENT;
    } catch (error) {
      return failed(
        `context transcript: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getContextInfo(
    hookData: ClaudeHookData,
  ): Promise<Outcome<ContextInfo>> {
    const nativeContext = this.calculateContextFromHookData(hookData);
    if (nativeContext) {
      return ok(nativeContext);
    }

    // [LAW:one-source-of-truth] current_usage can be null while size is present.
    const contextLimit =
      hookData.context_window?.context_window_size ?? DEFAULT_CONTEXT_WINDOW;

    return this.calculateContextTokensFromTranscript(
      hookData.transcript_path,
      contextLimit,
    );
  }
}
