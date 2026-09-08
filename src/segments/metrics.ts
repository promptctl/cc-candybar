import type { ClaudeHookData, ParsedEntry } from "../utils/claude";

// [LAW:one-source-of-truth] Metrics folds only the bytes appended since the last render, via the usage store's reader.
import { readAppendedEntries, type TranscriptCursor } from "../utils/claude";
import { statMtimeMs } from "../utils/transcript-fs";
import { debug } from "../utils/logger";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

// [LAW:types-are-the-program] "No cost data" is the `absent` arm, not a bag of nulls; lastResponseTime's domain genuinely has none.
export interface MetricsInfo {
  responseTime: number;
  lastResponseTime: number | null;
  sessionDuration: number;
  messageCount: number;
  linesAdded: number;
  linesRemoved: number;
}

// A bounded tail is all lastResponseTime needs; caps retained memory at O(1).
const RECENT_WINDOW = 20;
// LRU by insertion order — a long-lived daemon must not grow this map unbounded.
const MAX_SESSIONS = 256;

interface MetricsState {
  cursor: TranscriptCursor;
  messageCount: number;
  recent: ParsedEntry[];
}

function isRealUserMessage(entry: ParsedEntry): boolean {
  const messageType = entry.type || entry.message?.role || entry.message?.type;
  const isToolResult =
    entry.type === "user" && entry.message?.firstContentType === "tool_result";
  return messageType === "user" && !isToolResult;
}

export class MetricsProvider {
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

  // [LAW:dataflow-not-control-flow] Folds onto a FRESH state, so concurrent renders of one session last-writer-win rather than double-count.
  private async foldMetrics(
    sessionId: string,
    transcriptPath: string,
  ): Promise<
    // [LAW:types-are-the-program] Never `absent` — a missing transcript is a real zero-count fold.
    | { kind: "ok"; value: { messageCount: number; recent: ParsedEntry[] } }
    | { kind: "failed"; reason: string }
  > {
    const prior = this.state.get(sessionId);
    const mtime = statMtimeMs(transcriptPath);
    if (prior && mtime !== 0 && prior.cursor.mtimeMs === mtime) {
      // Re-order on the hit so LRU eviction reflects READ recency, not just write recency.
      this.state.delete(sessionId);
      this.state.set(sessionId, prior);
      // [LAW:no-shared-mutable-globals] Every path copies the ring out; a caller mutating it would corrupt retained state.
      return {
        kind: "ok",
        value: { messageCount: prior.messageCount, recent: [...prior.recent] },
      };
    }

    const read = await readAppendedEntries(transcriptPath, prior?.cursor);
    if (read.kind === "failed") return read;
    if (read.kind === "absent") {
      // Fresh session: keep prior, but cache no cursor so the next render retries.
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
    return { kind: "ok", value: { messageCount, recent: [...recent] } };
  }

  // [LAW:no-silent-failure] No cost block is `absent`; a parse error is `failed`.
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
