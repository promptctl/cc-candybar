import type { ClaudeHookData } from "../utils/claude.js";
import { ABSENT, ok, type Reading } from "../utils/outcome.js";

// [LAW:types-are-the-program] What the transcript says of the session's
// turns, and nothing of the hook: the session's facts carry this, so it can be
// gathered from the transcript alone. The one null is lastResponseTime, where
// the domain genuinely has no answer (no qualifying user→assistant pair in the
// recent window).
export interface MetricsFold {
  lastResponseTime: number | null;
  messageCount: number;
  // User entries that are neither a prompt nor a tool result — a fact for the
  // render event, so a count of prompts that stops moving can be told from a
  // session with none.
  nonPrompts: number;
}

// [LAW:types-are-the-program] An `ok` MetricsInfo carries real values — "no
// cost data at all" is the `absent` outcome arm, not a bag of nulls.
export interface MetricsInfo extends MetricsFold {
  responseTime: number;
  sessionDuration: number;
  linesAdded: number;
  linesRemoved: number;
}

// [LAW:one-source-of-truth] The session's metrics as the renderer composes
// them: the hook's durations and lines, which are the request's own and
// always fresh, over the transcript's fold.
// [LAW:no-silent-failure] A hook payload with no cost block is `absent` (old
// clients), whatever the fold says.
export function metricsOver(
  fold: Reading<MetricsFold>,
  hookData: ClaudeHookData,
): Reading<MetricsInfo> {
  const cost = hookData.cost;
  if (!cost) return ABSENT;
  if (fold.kind !== "ok") return fold;
  return ok({
    ...fold.value,
    responseTime: cost.total_api_duration_ms / 1000,
    sessionDuration: cost.total_duration_ms / 1000,
    linesAdded: cost.total_lines_added,
    linesRemoved: cost.total_lines_removed,
  });
}
