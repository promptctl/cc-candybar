import type { ClaudeHookData, ParsedEntry, UserEntry } from "../utils/claude";

// [LAW:one-source-of-truth] Metrics reads the transcript through the shared
// incremental fold (src/utils/transcript-fold.ts), which folds only the bytes
// added since the last render into a running message count + a bounded
// recent-entry ring — never a whole-file re-parse. Before this, metrics
// re-parsed the entire growing transcript every render (free only while it
// piggybacked the store's cache hit); once the usage store went incremental, a
// full re-parse here would have re-inherited the very stall that fix removed.
// The fold machinery itself moved out when the activity provider became its
// second instance (brandon-activity-ue7): what is left here is the projection.
import { TranscriptFold, type FoldOutcome } from "../utils/transcript-fold";
import { debug, quietLogger, type DaemonLogger } from "../utils/logger";
import { RefreshLedger } from "../utils/refresh-ledger";
import type { Timekeeper } from "../time";

import {
  ABSENT,
  failed,
  ok,
  type Outcome,
  type Reading,
} from "../utils/outcome";

// [LAW:types-are-the-program] An `ok` MetricsInfo carries real values — "no
// cost data at all" is the `absent` outcome arm, not a bag of nulls. The one
// remaining null is lastResponseTime, where the domain genuinely has no
// answer (no qualifying user→assistant pair in the recent window).
export interface MetricsInfo {
  responseTime: number;
  lastResponseTime: number | null;
  sessionDuration: number;
  messageCount: number;
  // User entries that are neither a prompt nor a tool result — a fact for the
  // render event, so a count of prompts that stops moving can be told from a
  // session with none.
  nonPrompts: number;
  linesAdded: number;
  linesRemoved: number;
}

// [LAW:types-are-the-program] What the transcript says of the session's
// turns, and nothing of the hook: the session's facts carry this, so it can be
// gathered from the transcript alone.
export type MetricsFold = Pick<
  MetricsInfo,
  "messageCount" | "nonPrompts" | "lastResponseTime"
>;

// lastResponseTime only inspects the most recent turns for a user→assistant
// pair; a bounded tail of non-sidechain entries is all it needs. The ring caps
// per-session retained memory at O(1) regardless of transcript length.
const RECENT_WINDOW = 20;

// [LAW:types-are-the-program] The immutable fold state: the running prompt
// count, the running count of the other user entries, and the recent-entry
// ring. Canonical; MetricsFold derives from it, and the hook's fields
// (durations, lines) are laid over it where the hook is (`metricsOver`).
interface MetricsState {
  readonly messageCount: number;
  readonly nonPrompts: number;
  readonly recent: readonly ParsedEntry[];
}

const EMPTY: MetricsState = {
  messageCount: 0,
  nonPrompts: 0,
  recent: [],
};

// [LAW:dataflow-not-control-flow] One entry onto the prior state, producing a
// FRESH state — so two concurrent renders of one session both fold from the same
// prior and last-writer-wins is a correct answer, never a double-count, and the
// stored state can be handed out without copying.
const NON_PROMPTS: ReadonlySet<UserEntry | undefined> = new Set<UserEntry>([
  "turn",
  "interrupt",
  "claude-code",
]);

function step(state: MetricsState, entry: ParsedEntry): MetricsState {
  if (entry.isSidechain) return state;
  const grown = [...state.recent, entry];
  return {
    messageCount: state.messageCount + (entry.userEntry === "prompt" ? 1 : 0),
    nonPrompts: state.nonPrompts + (NON_PROMPTS.has(entry.userEntry) ? 1 : 0),
    recent: grown.length > RECENT_WINDOW ? grown.slice(-RECENT_WINDOW) : grown,
  };
}

function lastResponseTime(entries: readonly ParsedEntry[]): number | null {
  let lastUserTime: Date | null = null;
  let best: number | null = null;

  for (const entry of entries) {
    const messageType =
      entry.type || entry.message?.role || entry.message?.type;

    // The clock starts where a turn does — a prompt, or Claude Code opening
    // another turn of it; a skill's body written mid-turn does not restart it.
    if (entry.userEntry === "prompt" || entry.userEntry === "turn") {
      lastUserTime = entry.timestamp;
    } else if (messageType === "assistant" && lastUserTime) {
      const elapsed =
        (entry.timestamp.getTime() - lastUserTime.getTime()) / 1000;
      if (elapsed > 0.1 && elapsed < 300) best = elapsed;
    }
  }

  return best;
}

export class MetricsProvider {
  private readonly fold: TranscriptFold<MetricsState>;

  constructor(opts: {
    readonly clock: Pick<Timekeeper, "monotonic">;
    readonly logger?: DaemonLogger;
    readonly ledger?: RefreshLedger;
  }) {
    const logger = opts.logger ?? quietLogger;
    this.fold = new TranscriptFold<MetricsState>(
      EMPTY,
      step,
      (opts.ledger ?? new RefreshLedger(logger)).declare({
        name: "metrics",
        scope: "session",
        refresh: ["request"],
      }),
      opts.clock,
      logger,
    );
  }

  // The session's metrics fold, read from its transcript.
  // [LAW:no-silent-failure] A transcript parse error is `failed`, carried to
  // the payload boundary.
  async refresh(
    sessionId: string,
    transcriptPath: string,
  ): Promise<Outcome<MetricsFold>> {
    debug(`Getting metrics from the transcript for session: ${sessionId}`);
    return foldFrom(sessionId, await this.fold.read(sessionId, transcriptPath));
  }

  // The session's metrics fold as its last refresh left it, for a draw.
  foldOf(sessionId: string): Reading<MetricsFold> {
    const answer = this.fold.answer(sessionId);
    return answer.kind === "pending" ? answer : foldFrom(sessionId, answer);
  }
}

// [LAW:one-source-of-truth] The one projection of a fold's answer, whether a
// refresh just made it or a draw reads it as it stands.
function foldFrom(
  sessionId: string,
  folded: FoldOutcome<MetricsState>,
): Outcome<MetricsFold> {
  if (folded.kind === "failed") {
    return failed(`metrics (${sessionId}): ${folded.reason}`, folded.failedAt);
  }
  return ok({
    lastResponseTime: lastResponseTime(folded.value.recent),
    messageCount: folded.value.messageCount,
    nonPrompts: folded.value.nonPrompts,
  });
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
