import { debug } from "../utils/logger";
import { PricingService } from "./pricing";
import {
  findTranscriptFile,
  findAgentTranscripts,
  parseJsonlFile,
  type ParsedEntry,
  type ClaudeHookData,
} from "../utils/claude";
import { dirname } from "node:path";

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
  costUSD?: number;
}

export interface SessionUsage {
  totalCost: number;
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
  calculatedCost: number | null;
  officialCost: number | null;
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
    costUSD: entry.costUSD,
  };
}

export class SessionProvider {
  async getSessionUsage(sessionId: string): Promise<SessionUsage | null> {
    const transcriptPath = await findTranscriptFile(sessionId);
    if (!transcriptPath) {
      debug(`No transcript found for session: ${sessionId}`);
      return null;
    }
    return this.getSessionUsageFromPath(sessionId, transcriptPath);
  }

  // [LAW:single-enforcer] One parse+cost path, entered two ways. The daemon's
  // SessionUsageStore already holds the transcript path (hookData.transcript_path
  // or its seed scan), so it enters here directly and skips findTranscriptFile's
  // existsSync-per-project probe. getSessionUsage is the lookup-by-id wrapper.
  async getSessionUsageFromPath(
    sessionId: string,
    transcriptPath: string,
  ): Promise<SessionUsage | null> {
    try {
      debug(`Found transcript at: ${transcriptPath}`);

      const mainEntries = await parseJsonlFile(transcriptPath);
      const projectPath = dirname(transcriptPath);
      const agentTranscripts = await findAgentTranscripts(
        sessionId,
        projectPath,
      );

      debug(`Found ${agentTranscripts.length} agent transcripts for session`);

      // [LAW:one-source-of-truth] parseJsonlFile returns its cached entries
      // array BY REFERENCE; the parse cache is the canonical store of a file's
      // parsed entries and is shared across providers. Mutating that array
      // (the old `push`) corrupted the cache — agent entries leaked into the
      // main transcript's cached value and re-appended on every warm hit.
      // Build a fresh combined list instead so no shared array is touched.
      const agentEntries = (
        await Promise.all(agentTranscripts.map((p) => parseJsonlFile(p)))
      ).flat();
      const parsedEntries = [...mainEntries, ...agentEntries];

      if (parsedEntries.length === 0) {
        return { totalCost: 0, entries: [] };
      }

      const entries: SessionUsageEntry[] = [];
      let totalCost = 0;

      for (const entry of parsedEntries) {
        if (entry.message?.usage) {
          const sessionEntry = convertToSessionEntry(entry);

          if (sessionEntry.costUSD !== undefined) {
            totalCost += sessionEntry.costUSD;
          } else {
            const cost = await PricingService.calculateCostForEntry(entry.raw);
            sessionEntry.costUSD = cost;
            totalCost += cost;
          }

          entries.push(sessionEntry);
        }
      }

      debug(
        `Parsed ${entries.length} usage entries, total cost: $${totalCost.toFixed(4)}`,
      );
      return { totalCost, entries };
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
      { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    );
  }

  async getSessionInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<SessionInfo> {
    return this.toSessionInfo(await this.getSessionUsage(sessionId), hookData);
  }

  // [LAW:types-are-the-program] Pure projection SessionUsage → SessionInfo, no
  // I/O. The store computes it once per ingest from already-parsed usage; the
  // empty-usage arm yields the all-null SessionInfo (which the payload drops).
  toSessionInfo(
    sessionUsage: SessionUsage | null,
    hookData?: ClaudeHookData,
  ): SessionInfo {
    if (!sessionUsage || sessionUsage.entries.length === 0) {
      return {
        cost: null,
        calculatedCost: null,
        officialCost: null,
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

    const calculatedCost = sessionUsage.totalCost;
    const hookDataCost = hookData?.cost?.total_cost_usd ?? null;
    const cost = calculatedCost ?? hookDataCost;

    return {
      cost,
      calculatedCost,
      officialCost: hookDataCost,
      tokens: totalTokens,
      tokenBreakdown,
    };
  }
}
