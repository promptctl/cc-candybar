import { readFile } from "node:fs/promises";
import { debug } from "../utils/logger";
import { PricingService } from "./pricing";
import { findTranscriptFile } from "../utils/claude";

export interface MetricsInfo {
  responseTime: number | null;
  sessionDuration: number | null;
  messageCount: number | null;
  costBurnRate: number | null;
  tokenBurnRate: number | null;
}

interface TranscriptEntry {
  timestamp: string;
  type?: string;
  message?: {
    role?: string;
    type?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  costUSD?: number;
}


export class MetricsProvider {

  private async loadTranscriptEntries(
    sessionId: string
  ): Promise<TranscriptEntry[]> {
    try {
      const transcriptPath = await findTranscriptFile(sessionId);
      if (!transcriptPath) {
        debug(`No transcript found for session: ${sessionId}`);
        return [];
      }

      debug(`Loading transcript from: ${transcriptPath}`);

      const content = await readFile(transcriptPath, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line.trim());

      const entries: TranscriptEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as TranscriptEntry;
          entries.push(entry);
        } catch (parseError) {
          debug(`Failed to parse JSONL line: ${parseError}`);
          continue;
        }
      }

      debug(`Loaded ${entries.length} transcript entries`);
      return entries;
    } catch (error) {
      debug(`Error loading transcript for ${sessionId}:`, error);
      return [];
    }
  }

  private calculateResponseTimes(entries: TranscriptEntry[]): number | null {
    const userMessages: Date[] = [];
    const assistantMessages: Date[] = [];

    for (const entry of entries) {
      if (!entry.timestamp) continue;

      try {
        const timestamp = new Date(entry.timestamp);

        const messageType =
          entry.type || entry.message?.role || entry.message?.type;

        if (messageType === "user" || messageType === "human") {
          userMessages.push(timestamp);
          debug(`Found user message at ${timestamp.toISOString()}`);
        } else if (messageType === "assistant" || messageType === "ai") {
          assistantMessages.push(timestamp);
          debug(`Found assistant message at ${timestamp.toISOString()}`);
        } else if (entry.message?.usage) {
          assistantMessages.push(timestamp);
          debug(
            `Found assistant message with usage at ${timestamp.toISOString()}`
          );
        } else {
          debug(
            `Unknown message type: ${messageType}, has usage: ${!!entry.message?.usage}`
          );
        }
      } catch {
        continue;
      }
    }

    if (userMessages.length === 0 || assistantMessages.length === 0) {
      return null;
    }

    const responseTimes: number[] = [];

    for (const assistantTime of assistantMessages) {
      const priorUsers = userMessages.filter(
        (userTime) => userTime < assistantTime
      );

      if (priorUsers.length > 0) {
        const userTime = new Date(
          Math.max(...priorUsers.map((d) => d.getTime()))
        );
        const responseTime =
          (assistantTime.getTime() - userTime.getTime()) / 1000;

        if (responseTime > 0.1 && responseTime < 300) {
          responseTimes.push(responseTime);
          debug(`Valid response time: ${responseTime.toFixed(1)}s`);
        } else {
          debug(
            `Rejected response time: ${responseTime.toFixed(1)}s (outside 0.1s-5m range)`
          );
        }
      }
    }

    if (responseTimes.length === 0) {
      return null;
    }

    return (
      responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length
    );
  }

  private calculateSessionDuration(entries: TranscriptEntry[]): number | null {
    const timestamps: Date[] = [];

    for (const entry of entries) {
      if (!entry.timestamp) continue;

      try {
        timestamps.push(new Date(entry.timestamp));
      } catch {
        continue;
      }
    }

    if (timestamps.length < 2) {
      return null;
    }

    timestamps.sort((a, b) => a.getTime() - b.getTime());

    const lastTimestamp = timestamps[timestamps.length - 1];
    const firstTimestamp = timestamps[0];

    if (!lastTimestamp || !firstTimestamp) {
      return null;
    }

    const duration =
      (lastTimestamp.getTime() - firstTimestamp.getTime()) / 1000;
    return duration > 0 ? duration : null;
  }

  private calculateMessageCount(entries: TranscriptEntry[]): number {
    return entries.filter((entry) => {
      const messageType =
        entry.type || entry.message?.role || entry.message?.type;
      return messageType === "user" || messageType === "human";
    }).length;
  }

  private async calculateTotalCost(
    entries: TranscriptEntry[]
  ): Promise<number> {
    let total = 0;

    for (const entry of entries) {
      if (typeof entry.costUSD === "number") {
        total += entry.costUSD;
      } else if (entry.message?.usage) {
        const cost = await PricingService.calculateCostForEntry(entry);
        total += cost;
      }
    }

    return total;
  }

  private calculateTotalTokens(entries: TranscriptEntry[]): number {
    return entries.reduce((total, entry) => {
      const usage = entry.message?.usage;
      if (!usage) return total;

      return (
        total +
        (usage.input_tokens || 0) +
        (usage.output_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0)
      );
    }, 0);
  }

  async getMetricsInfo(sessionId: string): Promise<MetricsInfo> {
    try {
      debug(`Starting metrics calculation for session: ${sessionId}`);

      const entries = await this.loadTranscriptEntries(sessionId);

      if (entries.length === 0) {
        return {
          responseTime: null,
          sessionDuration: null,
          messageCount: null,
          costBurnRate: null,
          tokenBurnRate: null,
        };
      }

      const responseTime = this.calculateResponseTimes(entries);
      const sessionDuration = this.calculateSessionDuration(entries);
      const messageCount = this.calculateMessageCount(entries);

      let costBurnRate: number | null = null;
      let tokenBurnRate: number | null = null;

      if (sessionDuration && sessionDuration > 0) {
        const hoursElapsed = sessionDuration / 3600;

        const totalCost = await this.calculateTotalCost(entries);
        const totalTokens = this.calculateTotalTokens(entries);

        if (totalCost > 0) {
          costBurnRate = totalCost / hoursElapsed;
        }

        if (totalTokens > 0) {
          tokenBurnRate = totalTokens / hoursElapsed;
        }
      }

      debug(
        `Metrics calculated: responseTime=${responseTime?.toFixed(2) || "null"}s, sessionDuration=${sessionDuration?.toFixed(0) || "null"}s, messageCount=${messageCount}`
      );

      return {
        responseTime,
        sessionDuration,
        messageCount,
        costBurnRate,
        tokenBurnRate,
      };
    } catch (error) {
      debug(`Error calculating metrics for session ${sessionId}:`, error);
      return {
        responseTime: null,
        sessionDuration: null,
        messageCount: null,
        costBurnRate: null,
        tokenBurnRate: null,
      };
    }
  }
}
