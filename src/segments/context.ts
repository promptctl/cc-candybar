import type { ParsedEntry, ClaudeHookData } from "../utils/claude";

import { debug } from "../utils/logger";
import { parseJsonlFile } from "../utils/claude";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

export interface ContextInfo {
  totalTokens: number;
  // Used / remaining percentages. Sourced from Claude's native
  // context_window.used_percentage / remaining_percentage when present; a
  // plain token-ratio is the only fallback (no auto-compact buffer guess).
  percentage: number;
  contextLeftPercentage: number;
  maxTokens: number;
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

  // Token-ratio percentages — the fallback ONLY. Used when Claude doesn't
  // report used_percentage / remaining_percentage natively (transcript path,
  // or a native window whose percentages are still null pre-first-call). No
  // auto-compact buffer: that was a hardcoded guess at Claude's threshold and
  // a soft second source; the native remaining_percentage is authoritative.
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

  /**
   * Calculate context info from native Claude Code context_window data (preferred).
   * Requires Claude Code 2.0.70+ with current_usage field.
   */
  calculateContextFromHookData(hookData: ClaudeHookData): ContextInfo | null {
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

    // [LAW:one-source-of-truth] Claude's reported used/remaining percentages
    // are authoritative; the token-ratio is only a floor for the window whose
    // percentages are still null (pre-first-call). remaining_percentage is NOT
    // recomputed from a local buffer — it measures real headroom to the limit.
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

  /**
   * Calculate context tokens by parsing the transcript file (fallback).
   * Used for older Claude Code versions that don't provide context_window.
   *
   * [LAW:no-silent-failure] An unreadable transcript is `failed` (the payload
   * boundary logs it); a transcript with no usable usage entry is `absent`.
   * The old catch-to-null collapsed both into "no data".
   */
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

  /**
   * Get context info using native data if available, falling back to transcript parsing.
   */
  async getContextInfo(
    hookData: ClaudeHookData,
  ): Promise<Outcome<ContextInfo>> {
    const nativeContext = this.calculateContextFromHookData(hookData);
    if (nativeContext) {
      return ok(nativeContext);
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
    );
  }
}
