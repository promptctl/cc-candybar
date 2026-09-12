// [LAW:one-source-of-truth] The ONE incremental per-session transcript fold.
//
// Two providers maintain a running projection of a session's transcript that
// must be O(bytes appended since the last render), not O(transcript): the
// metrics message count and the activity record (brandon-activity-ue7). Both
// need the same four non-obvious policies — the mtime fast path, the LRU-capped
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
  readAppendedEntries,
  type ParsedEntry,
  type TranscriptCursor,
} from "./claude";
import { statMtimeMs } from "./transcript-fs";

// [LAW:types-are-the-program] Never `absent`: a session with no transcript yet
// is a real empty fold, so the caller has exactly two arms.
export type FoldOutcome<S> =
  | { readonly kind: "ok"; readonly value: S }
  | { readonly kind: "failed"; readonly reason: string };

// A long-lived daemon sees many sessions; each retained state is small, but the
// map must not grow without bound. LRU by insertion order, evicting past the cap.
const MAX_SESSIONS = 256;

interface Retained<S> {
  readonly cursor: TranscriptCursor;
  readonly value: S;
}

export class TranscriptFold<S> {
  // [LAW:no-shared-mutable-globals] Single owner, hard cap, LRU eviction. One
  // instance per projection per daemon.
  private readonly states = new Map<string, Retained<S>>();

  constructor(
    private readonly empty: S,
    private readonly step: (state: S, entry: ParsedEntry) => S,
    private readonly maxSessions: number = MAX_SESSIONS,
  ) {}

  async read(
    sessionId: string,
    transcriptPath: string,
  ): Promise<FoldOutcome<S>> {
    const prior = this.states.get(sessionId);
    const mtime = statMtimeMs(transcriptPath);
    // [LAW:no-ambient-temporal-coupling] Fast hit: the transcript has not moved
    // since we last folded it, so the prior state stands. Re-ordering on the HIT
    // makes eviction reflect read recency, so an active session whose transcript
    // is momentarily unchanged is not evicted ahead of idle ones.
    if (prior && mtime !== 0 && prior.cursor.mtimeMs === mtime) {
      this.touch(sessionId, prior);
      return { kind: "ok", value: prior.value };
    }

    const read = await readAppendedEntries(transcriptPath, prior?.cursor);
    if (read.kind === "failed") return read;
    if (read.kind === "absent") {
      // No transcript yet (a fresh session). Keep whatever we had and cache NO
      // cursor, so the next render retries the moment the file appears.
      return { kind: "ok", value: prior?.value ?? this.empty };
    }

    const { entries, cursor, reset } = read.value;
    // [LAW:one-source-of-truth] `reset` is the single signal that the prior fold
    // is no longer a prefix of this file (a rename-based /compact, a truncation),
    // and the appended bytes then start at offset 0 — so the fold starts over.
    let value = reset || prior === undefined ? this.empty : prior.value;
    for (const entry of entries) value = this.step(value, entry);

    this.touch(sessionId, { cursor, value });
    while (this.states.size > this.maxSessions) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
    return { kind: "ok", value };
  }

  private touch(sessionId: string, state: Retained<S>): void {
    this.states.delete(sessionId);
    this.states.set(sessionId, state);
  }
}
