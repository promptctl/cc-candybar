import { debug } from "../utils/logger";
import { PricingService } from "./pricing";
import { failed, ok, type Outcome } from "../utils/outcome";
import {
  findAgentTranscripts,
  parseJsonlFile,
  type ParsedEntry,
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
  // [LAW:one-source-of-truth] The transcript path is always in hand — the
  // daemon's SessionUsageStore holds it (hookData.transcript_path or its seed
  // scan) and passes it straight here. There is no lookup-by-id path: recovering
  // a path we already hold by scanning every project dir is the data-duplication
  // this method exists to avoid.
  // [LAW:no-silent-failure] A transcript that exists but can't be read or
  // parsed is `failed`, not an empty session — the old catch-to-null dressed
  // a read failure as "no usage", and the lie survived all the way to the
  // rendered bar. An empty transcript is a real (zero-entry) usage, not
  // absence.
  async getSessionUsageFromPath(
    sessionId: string,
    transcriptPath: string,
  ): Promise<Outcome<SessionUsage>> {
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
        return ok({ totalCost: 0, entries: [] });
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
      return ok({ totalCost, entries });
    } catch (error) {
      return failed(
        `session transcript (${sessionId}): ${error instanceof Error ? error.message : String(error)}`,
      );
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

  // [LAW:types-are-the-program] Pure projection SessionUsage → SessionInfo, no
  // I/O. The store computes it once per ingest from already-parsed usage; the
  // empty-usage arm yields the all-null SessionInfo (which the payload drops).
  toSessionInfo(sessionUsage: SessionUsage): SessionInfo {
    if (sessionUsage.entries.length === 0) {
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

    // [LAW:single-enforcer] Transcript-derived projection only. `cost` is the
    // priced-transcript total; the authoritative native cost (officialCost =
    // hook total_cost_usd) is overlaid by the store at READ time — it is
    // per-render and must not be frozen into this mtime-keyed record, so it is
    // null here by construction.
    const calculatedCost = sessionUsage.totalCost;

    return {
      cost: calculatedCost,
      calculatedCost,
      officialCost: null,
      tokens: totalTokens,
      tokenBreakdown,
    };
  }
}
