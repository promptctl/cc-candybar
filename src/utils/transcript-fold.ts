// [LAW:one-source-of-truth] The ONE incremental per-session transcript fold.
//
// Two providers maintain a running projection of a session's transcript that
// must be O(bytes appended since the last render), not O(transcript): the
// metrics message count and the activity record (brandon-activity-ue7). Both
// need the same four non-obvious policies — the stamp fast path, the LRU-capped
// session map, the `reset` arm that re-folds from empty when a /compact rewrote
// the file, and "a missing transcript is a real empty fold, not a failure" —
// and two independently-written copies of those four WOULD drift, the reset arm
// first, because it is the one no ordinary session exercises.
//
// So the machinery lives here once and the variability is the fold VALUE:
// an `empty` state and a pure `step`. [LAW:dataflow-not-control-flow] — nothing
// about which projection is being maintained reaches this module.
//
// [LAW:types-are-the-program] `S` is immutable and `step` returns a FRESH state,
// which is what makes handing the stored value straight back to the caller safe.
// The previous hand-rolled copy in the metrics provider had to copy its ring out
// on all three exit paths, with a comment on each explaining the heisenbug a
// missed copy would cause; an immutable state deletes the hazard rather than
// guarding it.

import {
  foldAppended,
  longLineLog,
  type Folded,
  type ParsedEntry,
} from "./claude";
import { statStamp } from "./transcript-fs";
import { quietLogger, type DaemonLogger } from "./logger";
import { PENDING, type Pending } from "./outcome";
import { ObservableLru } from "./observable-lru";
import { valueOf } from "./logfmt";
import type { Refreshes } from "./refresh-ledger";

// [LAW:types-are-the-program] Never `absent`: a session with no transcript yet
// is a real empty fold, so the caller has exactly two arms.
export type FoldOutcome<S> =
  | { readonly kind: "ok"; readonly value: S }
  | { readonly kind: "failed"; readonly reason: string };

// A long-lived daemon sees many sessions; each retained state is small, but the
// map must not grow without bound. LRU by insertion order, evicting past the cap.
const MAX_SESSIONS = 256;

// One session's fold: the state its cursor covers (none until the transcript
// has bytes), and what the last read answered — which a draw takes as it
// stands, so it reads a failure the last refresh met rather than a fold from
// before it.
interface Session<S> {
  readonly folded: Folded<S> | undefined;
  readonly answer: FoldOutcome<S>;
}

export class TranscriptFold<S> {
  // [LAW:no-shared-mutable-globals] Single owner, hard cap, LRU eviction. One
  // instance per projection per daemon. Observable, so a view's payload over
  // an answer is recomputed in the turn the answer is stored.
  private readonly sessions: ObservableLru<string, Session<S>>;

  constructor(
    private readonly empty: S,
    private readonly step: (state: S, entry: ParsedEntry) => S,
    // The projection's source: a session's fold, refreshed by its request.
    private readonly refreshes: Refreshes<"request">,
    private readonly log: DaemonLogger = quietLogger,
    maxSessions: number = MAX_SESSIONS,
  ) {
    this.sessions = new ObservableLru(maxSessions);
  }

  // [LAW:effects-at-boundaries] The session's refresh: folds what was
  // appended since its last read, and stores what it answered.
  async read(
    sessionId: string,
    transcriptPath: string,
  ): Promise<FoldOutcome<S>> {
    const held = this.sessions.get(sessionId);
    const prior = held?.folded;
    const stamp = statStamp(transcriptPath);
    // [LAW:no-ambient-temporal-coupling] Fast hit: the transcript has not moved
    // since we last folded it, so the prior state stands. The hit counts as a
    // use, so an active session whose transcript is momentarily unchanged is
    // not evicted ahead of idle ones; an answer already standing is not
    // stored again, so no view reading it wakes.
    if (held?.folded && stamp !== "" && held.folded.cursor.stamp === stamp) {
      const { folded, answer } = held;
      if (answer.kind === "ok" && answer.value === folded.value) {
        this.sessions.touch(sessionId);
        return answer;
      }
      return this.store(sessionId, folded, { kind: "ok", value: folded.value });
    }

    const startedAt = Date.now();
    const read = await foldAppended(
      transcriptPath,
      prior,
      this.empty,
      (state, entries) => entries.reduce(this.step, state),
    );
    this.refreshes.recorded(
      `sid=${valueOf(sessionId)}`,
      "request",
      read,
      Date.now() - startedAt,
    );
    if (read.kind === "failed") return this.store(sessionId, prior, read);
    if (read.kind === "absent") {
      // No transcript yet (a fresh session). Keep whatever we had and cache NO
      // cursor, so the next render retries the moment the file appears.
      return this.store(sessionId, prior, {
        kind: "ok",
        value: prior?.value ?? this.empty,
      });
    }

    const { folded, longLines } = read.value;
    for (const line of longLineLog(longLines)) this.log("info", line);
    return this.store(sessionId, folded, { kind: "ok", value: folded.value });
  }

  // What the session's last read answered, as it stands: never read is
  // pending, its first read the next request's.
  answer(sessionId: string): FoldOutcome<S> | Pending {
    return this.sessions.get(sessionId)?.answer ?? PENDING;
  }

  private store(
    sessionId: string,
    folded: Folded<S> | undefined,
    answer: FoldOutcome<S>,
  ): FoldOutcome<S> {
    this.sessions.set(sessionId, { folded, answer });
    return answer;
  }
}
