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
import { TranscriptFold } from "../utils/transcript-fold";
import type { DaemonLogger } from "../utils/logger";
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
  // User entries that are neither a prompt nor a tool result — a fact for the
  // render event, so a count of prompts that stops moving can be told from a
  // session with none.
  nonPrompts: number;
  linesAdded: number;
  linesRemoved: number;
}

// lastResponseTime only inspects the most recent turns for a user→assistant
// pair; a bounded tail of non-sidechain entries is all it needs. The ring caps
// per-session retained memory at O(1) regardless of transcript length.
const RECENT_WINDOW = 20;

// [LAW:types-are-the-program] The immutable fold state: the running prompt
// count, the running count of the other user entries, and the recent-entry
// ring. Canonical; MetricsInfo's
// transcript-derived fields derive from it, the hookData-derived fields
// (durations, lines) are always fresh.
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

  constructor(opts: { logger?: DaemonLogger } = {}) {
    this.fold = new TranscriptFold<MetricsState>(EMPTY, step, opts.logger);
  }

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
      nonPrompts: folded.value.nonPrompts,
      linesAdded: hookData.cost.total_lines_added,
      linesRemoved: hookData.cost.total_lines_removed,
    });
  }
}
