import type { SessionId } from "../foundations/session-id.js";
import type { MetricsFold } from "../../segments/metrics.js";
import type { Timekeeper } from "../../time.js";
import type { ParsedEntry, UserEntry } from "../../utils/claude.js";
import { debug, quietLogger, type DaemonLogger } from "../../utils/logger.js";
import { failed, ok, type Outcome, type Reading } from "../../utils/outcome.js";
import {
  RefreshLedger,
  type RefreshTrigger,
} from "../../utils/refresh-ledger.js";
import {
  TranscriptFold,
  type FoldOutcome,
} from "../../utils/transcript-fold.js";

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
      (opts.ledger ?? new RefreshLedger(logger)).declare<RefreshTrigger>({
        name: "metrics",
        scope: "session",
        refresh: ["first", "period", "change"],
        lines: [],
      }),
      opts.clock,
      logger,
    );
  }

  // The session's metrics fold, read from its transcript.
  // [LAW:no-silent-failure] A transcript parse error is `failed`, carried to
  // the payload boundary.
  async refresh(
    sessionId: SessionId,
    transcriptPath: string,
    by: RefreshTrigger,
  ): Promise<Outcome<MetricsFold>> {
    debug(`Getting metrics from the transcript for session: ${sessionId}`);
    return foldFrom(
      sessionId,
      await this.fold.read(sessionId, transcriptPath, by),
    );
  }

  // The session's metrics fold as its last refresh left it, for a draw.
  foldOf(sessionId: SessionId): Reading<MetricsFold> {
    const answer = this.fold.answer(sessionId);
    return answer.kind === "pending" ? answer : foldFrom(sessionId, answer);
  }
}

// [LAW:one-source-of-truth] The one projection of a fold's answer, whether a
// refresh just made it or a draw reads it as it stands.
function foldFrom(
  sessionId: SessionId,
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
