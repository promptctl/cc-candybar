// [LAW:decomposition] The session usage CONTRACT — the shapes the daemon's
// SessionUsageStore produces and the render payload reads. The transcript fold
// that produces them is incremental and lives in the store (its single owner);
// this module is the type seam both sides agree on.

import type { ClaudeHookData } from "../utils/claude";
import { ok, type Reading } from "../utils/outcome";

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

// [LAW:types-are-the-program] What a session's transcript sums to: its
// entries priced against the rate table, and their tokens. The session's facts
// carry this and nothing of the hook, so it can be gathered from the
// transcript alone.
export interface TranscriptUsage {
  calculatedCost: number | null;
  tokens: number | null;
  tokenBreakdown: TokenBreakdown | null;
}

export interface SessionInfo extends TranscriptUsage {
  cost: number | null;
  officialCost: number | null;
}

export interface UsageInfo {
  session: SessionInfo;
}

// [LAW:one-source-of-truth] The `session` projection's last step, the
// renderer's: Claude's reported total_cost_usd is the authoritative cost of the
// active session. The priced transcript total is a reimplementation — kept
// ONLY as a fallback for clients that omit cost, and to feed the cross-session
// `today` total, which has no native source (past sessions expose only their
// transcripts, not a live cost figure). The hook's cost changes every request
// while the transcript total moves only when the file does, so it is laid over
// the fold where the hook is, never stored with it.
export function usageOver(
  fold: Reading<TranscriptUsage>,
  hookData: ClaudeHookData,
): Reading<UsageInfo> {
  if (fold.kind !== "ok") return fold;
  const officialCost = hookData.cost?.total_cost_usd ?? null;
  return ok({
    session: {
      ...fold.value,
      cost: officialCost ?? fold.value.calculatedCost,
      officialCost,
    },
  });
}
