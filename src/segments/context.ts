import type { ParsedEntry, ClaudeHookData } from "../utils/claude";

import {
  ABSENT,
  failed,
  ok,
  type Outcome,
  type Reading,
} from "../utils/outcome";
import { TranscriptFold, type FoldOutcome } from "../utils/transcript-fold";
import { debug, quietLogger, type DaemonLogger } from "../utils/logger";
import { RefreshLedger } from "../utils/refresh-ledger";
import type { Timekeeper } from "../time";

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

// [LAW:types-are-the-program] What the transcript says the context holds: the
// tokens of the newest main-chain entry carrying usage, or undefined while no
// such entry has been seen (the fallback then has nothing to report).
type ContextState = number | undefined;

// The newest usage-bearing, non-sidechain entry replaces what came before.
function step(state: ContextState, entry: ParsedEntry): ContextState {
  const usage = entry.message?.usage;
  if (!usage?.input_tokens || entry.isSidechain === true) return state;
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  );
}

export class ContextProvider {
  // [LAW:one-source-of-truth] The context fallback is a fold like metrics and
  // activity: one number per session, kept incrementally, rather than every
  // entry of the transcript re-parsed to find the last one.
  private readonly fold: TranscriptFold<ContextState>;

  constructor(opts: {
    readonly clock: Pick<Timekeeper, "monotonic">;
    readonly logger?: DaemonLogger;
    readonly ledger?: RefreshLedger;
  }) {
    const logger = opts.logger ?? quietLogger;
    this.fold = new TranscriptFold<ContextState>(
      undefined,
      step,
      (opts.ledger ?? new RefreshLedger(logger)).declare({
        name: "context",
        scope: "session",
        refresh: ["request"],
      }),
      opts.clock,
      logger,
    );
  }

  // The session's context tokens, folded from the transcript's newest
  // main-chain usage entry.
  // [LAW:no-silent-failure] An unreadable transcript is `failed` (the payload
  // boundary logs it); a transcript with no usable usage entry is `absent`.
  async refresh(
    sessionId: string,
    transcriptPath: string,
  ): Promise<Outcome<number>> {
    return tokensFrom(await this.fold.read(sessionId, transcriptPath));
  }

  // The session's context tokens as its last refresh left them, for a draw.
  tokensOf(sessionId: string): Reading<number> {
    const answer = this.fold.answer(sessionId);
    return answer.kind === "pending" ? answer : tokensFrom(answer);
  }
}

// [LAW:one-source-of-truth] The one projection of the fold's answer.
function tokensFrom(read: FoldOutcome<ContextState>): Outcome<number> {
  if (read.kind === "failed") {
    return failed(`context transcript: ${read.reason}`, read.failedAt);
  }
  if (read.value === undefined) {
    debug("No main chain entries with usage data found");
    return ABSENT;
  }
  return ok(read.value);
}

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
