import type { ClaudeHookData, ParsedEntry } from "../utils/claude";

// [LAW:one-source-of-truth] Metrics reads the transcript through the shared
// mtime-keyed parse LRU — the same parse the session/context segments already
// performed this render — instead of a private readFile+parse. One parse path,
// one cache; the multi-MB content arrays are dropped at parse time.
import { parseJsonlFile } from "../utils/claude";
import { debug } from "../utils/logger";

export interface MetricsInfo {
  responseTime: number | null;
  lastResponseTime: number | null;
  sessionDuration: number | null;
  messageCount: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

// A real user turn vs. a tool_result echoed back as a "user" line. The
// discriminator is metrics-local policy over the shared ParsedEntry scalars.
function isRealUserMessage(entry: ParsedEntry): boolean {
  const messageType = entry.type ?? entry.message?.role ?? entry.message?.type;
  const isToolResult =
    entry.type === "user" && entry.message?.firstContentType === "tool_result";
  return messageType === "user" && !isToolResult;
}

export class MetricsProvider {
  private calculateMessageCount(entries: ParsedEntry[]): number {
    return entries.filter(isRealUserMessage).length;
  }

  private calculateLastResponseTime(entries: ParsedEntry[]): number | null {
    if (entries.length === 0) return null;

    const recentEntries = entries.slice(-20);

    let lastUserTime: Date | null = null;
    let bestResponseTime: number | null = null;

    for (const entry of recentEntries) {
      const messageType =
        entry.type ?? entry.message?.role ?? entry.message?.type;

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

  async getMetricsInfo(
    sessionId: string,
    hookData: ClaudeHookData,
  ): Promise<MetricsInfo> {
    try {
      debug(`Getting metrics from hook data for session: ${sessionId}`);

      if (!hookData.cost) {
        debug(`No cost data available in hook data`);
        return {
          responseTime: null,
          lastResponseTime: null,
          sessionDuration: null,
          messageCount: null,
          linesAdded: null,
          linesRemoved: null,
        };
      }

      // parseJsonlFile keeps sidechain entries (usage needs them); metrics
      // counts only main-thread turns, so the sidechain exclusion is local.
      const entries = (await parseJsonlFile(hookData.transcript_path)).filter(
        (entry) => !entry.isSidechain,
      );
      const messageCount = this.calculateMessageCount(entries);
      const lastResponseTime = this.calculateLastResponseTime(entries);

      return {
        responseTime: hookData.cost.total_api_duration_ms / 1000,
        lastResponseTime,
        sessionDuration: hookData.cost.total_duration_ms / 1000,
        messageCount,
        linesAdded: hookData.cost.total_lines_added,
        linesRemoved: hookData.cost.total_lines_removed,
      };
    } catch (error) {
      debug(
        `Error getting metrics from hook data for session ${sessionId}:`,
        error,
      );
      return {
        responseTime: null,
        lastResponseTime: null,
        sessionDuration: null,
        messageCount: null,
        linesAdded: null,
        linesRemoved: null,
      };
    }
  }
}
