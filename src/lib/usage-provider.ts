import { loadSessionUsageById, getClaudePaths } from "ccusage/data-loader";
import { logger } from "ccusage/logger";
import { debug } from "./logger";

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface UsageInfo {
  session: {
    cost: number | null;
    tokens: number | null;
    tokenBreakdown: TokenBreakdown | null;
  };
}

export class UsageProvider {
  async getUsageInfo(sessionId: string): Promise<UsageInfo> {
    const originalLevel = logger.level;
    logger.level = 0;

    try {
      debug(`Starting usage info retrieval for session: ${sessionId}`);
      const claudePaths = getClaudePaths();
      debug(`Found ${claudePaths.length} Claude paths:`, claudePaths);

      if (claudePaths.length === 0) {
        debug(`No Claude paths found, returning empty usage data`);
        return {
          session: { cost: null, tokens: null, tokenBreakdown: null },
        };
      }

      const sessionData = await this.getSessionData(sessionId);

      return {
        session: sessionData,
      };
    } catch {
      return {
        session: { cost: null, tokens: null, tokenBreakdown: null },
      };
    } finally {
      logger.level = originalLevel;
    }
  }

  private async getSessionData(sessionId: string) {
    try {
      debug(`Loading session data for ID: ${sessionId}`);

      const sessionData = await loadSessionUsageById(sessionId, {
        mode: "auto",
      });

      if (!sessionData) {
        debug(`No session data found for ID: ${sessionId}`);
        return { cost: null, tokens: null, tokenBreakdown: null };
      }

      const breakdown = sessionData.entries.reduce(
        (acc, entry) => {
          const usage = entry.message.usage;
          return {
            input: acc.input + usage.input_tokens,
            output: acc.output + usage.output_tokens,
            cacheCreation:
              acc.cacheCreation + (usage.cache_creation_input_tokens || 0),
            cacheRead: acc.cacheRead + (usage.cache_read_input_tokens || 0),
          };
        },
        { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
      );

      const totalTokens =
        breakdown.input +
        breakdown.output +
        breakdown.cacheCreation +
        breakdown.cacheRead;

      return {
        cost: sessionData.totalCost,
        tokens: totalTokens,
        tokenBreakdown: breakdown,
      };
    } catch (error) {
      debug(`Error loading session data for ID ${sessionId}:`, error);
      return { cost: null, tokens: null, tokenBreakdown: null };
    }
  }
}
