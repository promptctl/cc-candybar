import type { ClaudeHookData } from "../utils/claude.js";
import { ok, type Reading } from "../utils/outcome.js";

export interface ContextInfo {
  totalTokens: number;
  // Used / remaining percentages. Sourced from Claude's native
  // context_window.used_percentage / remaining_percentage when present; a
  // plain token-ratio is the only fallback (no auto-compact buffer guess).
  percentage: number;
  contextLeftPercentage: number;
  maxTokens: number;
}

// [LAW:one-source-of-truth] The context-window size is NEVER guessed from the
// model name. Claude Code reports the real size for the active model in
// `context_window.context_window_size` (1M for the [1m] variants, 200k
// otherwise) — that field is the single authority. This constant is the
// last-resort floor for ancient clients that omit `context_window` entirely;
// it is not a per-model table and must not grow into one.
const DEFAULT_CONTEXT_WINDOW = 200000;

// Token-ratio percentages — the fallback ONLY. Used when Claude doesn't
// report used_percentage / remaining_percentage natively (transcript path,
// or a native window whose percentages are still null pre-first-call). No
// auto-compact buffer: that was a hardcoded guess at Claude's threshold and
// a soft second source; the native remaining_percentage is authoritative.
function ratioPercentages(
  totalTokens: number,
  contextLimit: number,
): Pick<ContextInfo, "percentage" | "contextLeftPercentage"> {
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((totalTokens / contextLimit) * 100)),
  );
  return { percentage, contextLeftPercentage: Math.max(0, 100 - percentage) };
}

// Context info from native Claude Code context_window data (preferred), which
// Claude Code 2.0.70+ sends with its current_usage field.
function contextFromHook(hookData: ClaudeHookData): ContextInfo | null {
  const cw = hookData.context_window;
  if (!cw?.current_usage) return null;

  const currentUsage = cw.current_usage;
  // [LAW:no-defensive-null-guards] context_window_size is a required `number`
  // within context_window; reaching here proves cw is present, so the size
  // is too. No `|| default` — that would mask a malformed payload as 200k.
  const contextLimit = cw.context_window_size;
  const totalTokens =
    (currentUsage.input_tokens || 0) +
    (currentUsage.cache_creation_input_tokens || 0) +
    (currentUsage.cache_read_input_tokens || 0);

  // [LAW:one-source-of-truth] Claude's reported used/remaining percentages
  // are authoritative; the token-ratio is only a floor for the window whose
  // percentages are still null (pre-first-call). remaining_percentage is NOT
  // recomputed from a local buffer — it measures real headroom to the limit.
  const ratio = ratioPercentages(totalTokens, contextLimit);
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

// [LAW:one-source-of-truth] The session's context as the renderer composes
// it: the native window the request carried, else the transcript's tokens
// against the window size the hook reports. The native answer stands whatever
// the fold says, pending or failed, since the fold is only its fallback.
export function contextOver(
  tokens: Reading<number>,
  hookData: ClaudeHookData,
): Reading<ContextInfo> {
  const native = contextFromHook(hookData);
  if (native !== null) return ok(native);
  if (tokens.kind !== "ok") return tokens;
  const contextLimit = contextLimitOf(hookData);
  return ok({
    totalTokens: tokens.value,
    maxTokens: contextLimit,
    ...ratioPercentages(tokens.value, contextLimit),
  });
}

// [LAW:one-source-of-truth] current_usage can be null (pre-first-call or
// post-/compact) while context_window_size is still present and
// authoritative — prefer it here too, and only fall to the floor when the
// client omits context_window entirely.
function contextLimitOf(hookData: ClaudeHookData): number {
  return hookData.context_window?.context_window_size ?? DEFAULT_CONTEXT_WINDOW;
}
