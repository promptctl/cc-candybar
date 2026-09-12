import type { ClaudeHookData, ParsedEntry } from "../utils/claude";

// [LAW:one-source-of-truth] Metrics reads the transcript through the shared
// incremental fold (src/utils/transcript-fold.ts), which folds only the bytes
// added since the last render into a running message count + a bounded
// recent-entry ring — never a whole-file re-parse. Before this, metrics
// re-parsed the entire growing transcript every render (free only while it
// piggybacked the store's cache hit); once the usage store went incremental, a
// full re-parse here would have re-inherited the very stall that fix removed.
// The fold machinery itself moved out when the activity provider became its
// second instance (brandon-activity-ue7): what is left here is the projection.
import { isRealUserMessage } from "../utils/claude";
import { TranscriptFold } from "../utils/transcript-fold";
import { debug } from "../utils/logger";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

// [LAW:types-are-the-program] An `ok` MetricsInfo carries real values — "no
// cost data at all" is the `absent` outcome arm, not a bag of nulls. The one
// remaining null is lastResponseTime, where the domain genuinely has no
// answer (no qualifying user→assistant pair in the recent window).
export interface MetricsInfo {
  responseTime: number;
  lastResponseTime: number | null;
  sessionDuration: number;
  messageCount: number;
  linesAdded: number;
  linesRemoved: number;
}

// lastResponseTime only inspects the most recent turns for a user→assistant
// pair; a bounded tail of non-sidechain entries is all it needs. The ring caps
// per-session retained memory at O(1) regardless of transcript length.
const RECENT_WINDOW = 20;

// [LAW:types-are-the-program] The immutable fold state: the running real-user
// message count and the recent-entry ring. Canonical; MetricsInfo's
// transcript-derived fields derive from it, the hookData-derived fields
// (durations, lines) are always fresh.
interface MetricsState {
  readonly messageCount: number;
  readonly recent: readonly ParsedEntry[];
}

const EMPTY: MetricsState = { messageCount: 0, recent: [] };

// [LAW:dataflow-not-control-flow] One entry onto the prior state, producing a
// FRESH state — so two concurrent renders of one session both fold from the same
// prior and last-writer-wins is a correct answer, never a double-count, and the
// stored state can be handed out without copying.
function step(state: MetricsState, entry: ParsedEntry): MetricsState {
  if (entry.isSidechain) return state;
  const grown = [...state.recent, entry];
  return {
    messageCount: state.messageCount + (isRealUserMessage(entry) ? 1 : 0),
    recent: grown.length > RECENT_WINDOW ? grown.slice(-RECENT_WINDOW) : grown,
  };
}

function lastResponseTime(entries: readonly ParsedEntry[]): number | null {
  let lastUserTime: Date | null = null;
  let best: number | null = null;

  for (const entry of entries) {
    const messageType =
      entry.type || entry.message?.role || entry.message?.type;

    if (isRealUserMessage(entry)) {
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
  private readonly fold = new TranscriptFold<MetricsState>(EMPTY, step);

  // [LAW:no-silent-failure] A hook payload with no cost block is `absent`
  // (old clients); a transcript parse error is `failed`, carried to the
  // payload boundary — the old catch dressed it as the same all-null record
  // as "no data".
  async getMetricsInfo(
    sessionId: string,
    hookData: ClaudeHookData,
  ): Promise<Outcome<MetricsInfo>> {
    debug(`Getting metrics from hook data for session: ${sessionId}`);

    if (!hookData.cost) {
      return ABSENT;
    }

    const folded = await this.fold.read(sessionId, hookData.transcript_path);
    if (folded.kind === "failed") {
      return failed(`metrics (${sessionId}): ${folded.reason}`);
    }

    return ok({
      responseTime: hookData.cost.total_api_duration_ms / 1000,
      lastResponseTime: lastResponseTime(folded.value.recent),
      sessionDuration: hookData.cost.total_duration_ms / 1000,
      messageCount: folded.value.messageCount,
      linesAdded: hookData.cost.total_lines_added,
      linesRemoved: hookData.cost.total_lines_removed,
    });
  }
}
