import type { SessionId } from "../foundations/session-id.js";
import type { Timekeeper } from "../../time.js";
import type { ParsedEntry } from "../../utils/claude.js";
import { debug, quietLogger, type DaemonLogger } from "../../utils/logger.js";
import {
  ABSENT,
  failed,
  ok,
  type Outcome,
  type Reading,
} from "../../utils/outcome.js";
import {
  RefreshLedger,
  type RefreshTrigger,
} from "../../utils/refresh-ledger.js";
import {
  TranscriptFold,
  type FoldOutcome,
} from "../../utils/transcript-fold.js";

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
      (opts.ledger ?? new RefreshLedger(logger)).declare<RefreshTrigger>({
        name: "context",
        scope: "session",
        refresh: ["first", "period", "change"],
        lines: [],
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
    sessionId: SessionId,
    transcriptPath: string,
    by: RefreshTrigger,
  ): Promise<Outcome<number>> {
    return tokensFrom(await this.fold.read(sessionId, transcriptPath, by));
  }

  // The session's context tokens as its last refresh left them, for a draw.
  tokensOf(sessionId: SessionId): Reading<number> {
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
