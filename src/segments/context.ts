import type { ParsedEntry, ClaudeHookData } from "../utils/claude";

import { debug } from "../utils/logger";
import { parseJsonlFile } from "../utils/claude";

export interface ContextInfo {
  totalTokens: number;
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

// [LAW:one-source-of-truth] The context-window size is NEVER guessed from the
// model name. Claude Code reports the real size for the active model in
// `context_window.context_window_size` (1M for the [1m] variants, 200k
// otherwise) — that field is the single authority. This constant is the
// last-resort floor for ancient clients that omit `context_window` entirely;
// it is not a per-model table and must not grow into one.
const DEFAULT_CONTEXT_WINDOW = 200000;

export class ContextProvider {
  private readonly thresholds: ContextUsageThresholds = {
    LOW: 50,
    MEDIUM: 80,
  };

  getContextUsageThresholds(): ContextUsageThresholds {
    return this.thresholds;
  }

  private calculatePercentages(
    totalTokens: number,
    contextLimit: number,
    autocompactBuffer: number = 33000,
  ): Pick<
    ContextInfo,
    "percentage" | "usablePercentage" | "contextLeftPercentage" | "usableTokens"
  > {
    const percentage = Math.min(
      100,
      Math.max(0, Math.round((totalTokens / contextLimit) * 100)),
    );

    const usableLimit = Math.max(1, contextLimit - autocompactBuffer);
    const usablePercentage = Math.min(
      100,
      Math.max(0, Math.round((totalTokens / usableLimit) * 100)),
    );

    const contextLeftPercentage = Math.max(0, 100 - usablePercentage);

    return {
      percentage,
      usablePercentage,
      contextLeftPercentage,
      usableTokens: usableLimit,
    };
  }

  /**
   * Calculate context info from native Claude Code context_window data (preferred).
   * Requires Claude Code 2.0.70+ with current_usage field.
   */
  calculateContextFromHookData(
    hookData: ClaudeHookData,
    autocompactBuffer: number = 33000,
  ): ContextInfo | null {
    const cw = hookData.context_window;
    if (!cw?.current_usage) {
      debug(
        "No current_usage in hook data, falling back to transcript parsing",
      );
      return null;
    }

    const currentUsage = cw.current_usage;
    // [LAW:no-defensive-null-guards] context_window_size is a required `number`
    // within context_window; reaching here proves cw is present, so the size
    // is too. No `|| default` — that would mask a malformed payload as 200k.
    const contextLimit = cw.context_window_size;
    const totalTokens =
      (currentUsage.input_tokens || 0) +
      (currentUsage.cache_creation_input_tokens || 0) +
      (currentUsage.cache_read_input_tokens || 0);

    debug(
      `Native current_usage: input=${currentUsage.input_tokens}, cache_create=${currentUsage.cache_creation_input_tokens}, cache_read=${currentUsage.cache_read_input_tokens}, total=${totalTokens} (limit: ${contextLimit})`,
    );

    const nativePct = hookData.context_window?.used_percentage;
    const percentages = this.calculatePercentages(
      totalTokens,
      contextLimit,
      autocompactBuffer,
    );

    if (nativePct != null) {
      percentages.percentage = Math.round(nativePct);
      debug(`Using native used_percentage: ${nativePct}%`);
    }

    return {
      totalTokens,
      maxTokens: contextLimit,
      ...percentages,
    };
  }

  /**
   * Calculate context tokens by parsing the transcript file (fallback).
   * Used for older Claude Code versions that don't provide context_window.
   */
  async calculateContextTokensFromTranscript(
    transcriptPath: string,
    contextLimit: number,
    autocompactBuffer: number = 33000,
  ): Promise<ContextInfo | null> {
    try {
      debug(`Calculating context tokens from transcript: ${transcriptPath}`);

      const parsedEntries = await parseJsonlFile(transcriptPath);

      if (parsedEntries.length === 0) {
        debug("No entries in transcript");
        return null;
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

        const percentages = this.calculatePercentages(
          totalTokens,
          contextLimit,
          autocompactBuffer,
        );

        return {
          totalTokens,
          maxTokens: contextLimit,
          ...percentages,
        };
      }

      debug("No main chain entries with usage data found");
      return null;
    } catch (error) {
      debug(
        `Error reading transcript: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Get context info using native data if available, falling back to transcript parsing.
   */
  async getContextInfo(
    hookData: ClaudeHookData,
    autocompactBuffer: number = 33000,
  ): Promise<ContextInfo | null> {
    const nativeContext = this.calculateContextFromHookData(
      hookData,
      autocompactBuffer,
    );
    if (nativeContext) {
      return nativeContext;
    }

    // [LAW:one-source-of-truth] current_usage can be null (pre-first-call or
    // post-/compact) while context_window_size is still present and
    // authoritative — prefer it here too, and only fall to the floor when the
    // client omits context_window entirely.
    const contextLimit =
      hookData.context_window?.context_window_size ?? DEFAULT_CONTEXT_WINDOW;

    return this.calculateContextTokensFromTranscript(
      hookData.transcript_path,
      contextLimit,
      autocompactBuffer,
    );
  }
}
