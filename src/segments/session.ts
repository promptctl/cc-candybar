import { debug } from "../utils/logger";
import {
  findTranscriptFile,
  parseJsonlFile,
  type ParsedEntry,
  type ClaudeHookData,
} from "../utils/claude";

export interface SessionUsageEntry {
  timestamp: string;
  message: {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface SessionUsage {
  entries: SessionUsageEntry[];
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface SessionInfo {
  cost: number | null;
  tokens: number | null;
  tokenBreakdown: TokenBreakdown | null;
}

export interface UsageInfo {
  session: SessionInfo;
}

function convertToSessionEntry(entry: ParsedEntry): SessionUsageEntry {
  return {
    timestamp: entry.timestamp.toISOString(),
    message: {
      usage: {
        input_tokens: entry.message?.usage?.input_tokens || 0,
        output_tokens: entry.message?.usage?.output_tokens || 0,
        cache_creation_input_tokens:
          entry.message?.usage?.cache_creation_input_tokens,
        cache_read_input_tokens: entry.message?.usage?.cache_read_input_tokens,
      },
    },
  };
}

export class SessionProvider {
  async getSessionUsage(sessionId: string): Promise<SessionUsage | null> {
    try {
      const transcriptPath = await findTranscriptFile(sessionId);
      if (!transcriptPath) {
        debug(`No transcript found for session: ${sessionId}`);
        return null;
      }

      debug(`Found transcript at: ${transcriptPath}`);

      const parsedEntries = await parseJsonlFile(transcriptPath);

      if (parsedEntries.length === 0) {
        return { entries: [] };
      }

      const entries: SessionUsageEntry[] = [];

      for (const entry of parsedEntries) {
        if (entry.message?.usage) {
          const sessionEntry = convertToSessionEntry(entry);
          entries.push(sessionEntry);
        }
      }

      debug(`Parsed ${entries.length} usage entries`);
      return { entries };
    } catch (error) {
      debug(`Error reading session usage for ${sessionId}:`, error);
      return null;
    }
  }

  calculateTokenBreakdown(entries: SessionUsageEntry[]): TokenBreakdown {
    return entries.reduce(
      (breakdown, entry) => ({
        input: breakdown.input + (entry.message.usage.input_tokens || 0),
        output: breakdown.output + (entry.message.usage.output_tokens || 0),
        cacheCreation:
          breakdown.cacheCreation +
          (entry.message.usage.cache_creation_input_tokens || 0),
        cacheRead:
          breakdown.cacheRead +
          (entry.message.usage.cache_read_input_tokens || 0),
      }),
      { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
    );
  }

  async getSessionInfo(
    sessionId: string,
    hookData?: ClaudeHookData
  ): Promise<SessionInfo> {
    const sessionUsage = await this.getSessionUsage(sessionId);

    if (!sessionUsage || sessionUsage.entries.length === 0) {
      return {
        cost: null,
        tokens: null,
        tokenBreakdown: null,
      };
    }

    const tokenBreakdown = this.calculateTokenBreakdown(sessionUsage.entries);
    const totalTokens =
      tokenBreakdown.input +
      tokenBreakdown.output +
      tokenBreakdown.cacheCreation +
      tokenBreakdown.cacheRead;

    const cost = hookData?.cost?.total_cost_usd ?? null;

    return {
      cost,
      tokens: totalTokens,
      tokenBreakdown,
    };
  }
}

export class UsageProvider {
  private sessionProvider = new SessionProvider();

  async getUsageInfo(
    sessionId: string,
    hookData?: ClaudeHookData
  ): Promise<UsageInfo> {
    try {
      debug(`Starting usage info retrieval for session: ${sessionId}`);

      const sessionInfo = await this.sessionProvider.getSessionInfo(
        sessionId,
        hookData
      );

      return {
        session: sessionInfo,
      };
    } catch (error) {
      debug(`Error getting usage info for session ${sessionId}:`, error);
      return {
        session: { cost: null, tokens: null, tokenBreakdown: null },
      };
    }
  }
}
