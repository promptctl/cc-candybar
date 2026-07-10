import type { ClaudeHookData, ParsedEntry } from "../utils/claude";

// [LAW:one-source-of-truth] Metrics reads the transcript through the SAME
// incremental append reader the usage store uses, folding only the bytes added
// since last render into a running message count + a bounded recent-entry ring —
// never a whole-file re-parse. Before this, metrics re-parsed the entire growing
// transcript every render (free only while it piggybacked the store's cache hit);
// once the store went incremental, a full re-parse here would have re-inherited
// the very stall the store fix removed. Now both consumers are O(new bytes).
import { readAppendedEntries, type TranscriptCursor } from "../utils/claude";
import { statMtimeMs } from "../utils/transcript-fs";
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
// Bound the per-session fold map like the usage store's records — a long-lived
// daemon sees many sessions; the ring is tiny, but the map must not grow without
// limit. LRU by insertion order (delete+set on write), evict oldest past the cap.
const MAX_SESSIONS = 256;

// [LAW:one-source-of-truth] The incremental fold of one session's metrics: the
// byte cursor already consumed, the running real-user message count, and the
// recent-entry ring. Canonical; MetricsInfo's transcript-derived fields derive
// from it, the hookData-derived fields (durations, lines) are always fresh.
interface MetricsState {
  cursor: TranscriptCursor;
  messageCount: number;
  recent: ParsedEntry[];
}

// A real user turn vs. a tool_result echoed back as a "user" line. The
// discriminator is metrics-local policy over the shared ParsedEntry scalars.
function isRealUserMessage(entry: ParsedEntry): boolean {
  const messageType = entry.type || entry.message?.role || entry.message?.type;
  const isToolResult =
    entry.type === "user" && entry.message?.firstContentType === "tool_result";
  return messageType === "user" && !isToolResult;
}

export class MetricsProvider {
  // [LAW:no-shared-mutable-globals] Single owner, hard cap, LRU eviction — the
  // per-session incremental fold state. One instance per daemon.
  private readonly state = new Map<string, MetricsState>();

  private calculateLastResponseTime(entries: ParsedEntry[]): number | null {
    if (entries.length === 0) return null;

    let lastUserTime: Date | null = null;
    let bestResponseTime: number | null = null;

    for (const entry of entries) {
      const messageType =
        entry.type || entry.message?.role || entry.message?.type;

      if (isRealUserMessage(entry)) {
        lastUserTime = entry.timestamp;
      } else if (messageType === "assistant" && lastUserTime) {
        const responseTime =
          (entry.timestamp.getTime() - lastUserTime.getTime()) / 1000;
        if (responseTime > 0.1 && responseTime < 300) {
          bestResponseTime = responseTime;
        }
      }
    }

    return bestResponseTime;
  }

  // [LAW:dataflow-not-control-flow] Fold the appended entries onto the prior
  // state, producing a FRESH state (prior is never mutated) so two concurrent
  // renders of one session both fold from the same prior and last-writer-wins is
  // a correct answer, never a double-count. `reset` (a /compact rewrite) folds
  // from empty. Returns the transcript-derived fields the caller composes with
  // the always-fresh hookData fields.
  private async foldMetrics(
    sessionId: string,
    transcriptPath: string,
  ): Promise<
    // [LAW:types-are-the-program] Never `absent` — a missing transcript is a real
    // zero-count fold (ok), so the caller has exactly two arms to handle.
    | { kind: "ok"; value: { messageCount: number; recent: ParsedEntry[] } }
    | { kind: "failed"; reason: string }
  > {
    const prior = this.state.get(sessionId);
    const mtime = statMtimeMs(transcriptPath);
    // [LAW:no-ambient-temporal-coupling] Fast hit: the transcript is unchanged
    // since we last folded it, so the message count + ring stand.
    if (prior && mtime !== 0 && prior.cursor.mtimeMs === mtime) {
      // [LAW:no-ambient-temporal-coupling] Re-order on the hit so LRU eviction
      // reflects READ recency, not just write recency — an active session whose
      // transcript is momentarily unchanged must not be evicted ahead of idle
      // ones (matches the usage store's hit path).
      this.state.delete(sessionId);
      this.state.set(sessionId, prior);
      // [LAW:no-shared-mutable-globals] Return a COPY of the stored ring, never
      // the reference — a caller mutating the returned array would silently
      // corrupt the retained state (a heisenbug in the next render's
      // lastResponseTime). Every path (hit/miss/absent) copies. 20 entries.
      return {
        kind: "ok",
        value: { messageCount: prior.messageCount, recent: [...prior.recent] },
      };
    }

    const read = await readAppendedEntries(transcriptPath, prior?.cursor);
    if (read.kind === "failed") return read;
    if (read.kind === "absent") {
      // No transcript yet (fresh session) — keep prior if any, don't cache a
      // cursor so the next render retries when the file appears. Copy the ring
      // (like the hit/miss paths) so no stored reference escapes.
      return {
        kind: "ok",
        value: {
          messageCount: prior?.messageCount ?? 0,
          recent: [...(prior?.recent ?? [])],
        },
      };
    }

    const { entries, cursor, reset } = read.value;
    const base = prior && !reset ? prior : undefined;
    let messageCount = base?.messageCount ?? 0;
    let recent = base ? [...base.recent] : [];
    for (const entry of entries) {
      if (entry.isSidechain) continue;
      if (isRealUserMessage(entry)) messageCount++;
      recent.push(entry);
    }
    if (recent.length > RECENT_WINDOW) recent = recent.slice(-RECENT_WINDOW);

    this.state.delete(sessionId);
    this.state.set(sessionId, { cursor, messageCount, recent });
    while (this.state.size > MAX_SESSIONS) {
      const oldest = this.state.keys().next().value;
      if (oldest === undefined) break;
      this.state.delete(oldest);
    }
    // [LAW:no-shared-mutable-globals] `recent` is now the STORED array — copy it
    // out so the returned value shares no reference with retained state.
    return { kind: "ok", value: { messageCount, recent: [...recent] } };
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

    const folded = await this.foldMetrics(sessionId, hookData.transcript_path);
    if (folded.kind === "failed") {
      return failed(`metrics (${sessionId}): ${folded.reason}`);
    }

    return ok({
      responseTime: hookData.cost.total_api_duration_ms / 1000,
      lastResponseTime: this.calculateLastResponseTime(folded.value.recent),
      sessionDuration: hookData.cost.total_duration_ms / 1000,
      messageCount: folded.value.messageCount,
      linesAdded: hookData.cost.total_lines_added,
      linesRemoved: hookData.cost.total_lines_removed,
    });
  }
}
