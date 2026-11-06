import { debug } from "../utils/logger";
import { get } from "node:https";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Timekeeper } from "../time";
import type { DaemonLogger } from "../utils/logger";
import type { PrunedRaw } from "../utils/claude.js";

// Every model's rates, by model id.
export type PriceTable = Readonly<Record<string, ModelPricing>>;

export interface ModelPricing {
  name: string;
  input: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  output: number;
}
const OFFLINE_PRICING_DATA: PriceTable = {
  "claude-haiku-4-5-20251001": {
    name: "Claude Haiku 4.5",
    input: 1.0,
    output: 5.0,
    cache_write_5m: 1.25,
    cache_write_1h: 2.0,
    cache_read: 0.1,
  },
  "claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    input: 1.0,
    output: 5.0,
    cache_write_5m: 1.25,
    cache_write_1h: 2.0,
    cache_read: 0.1,
  },
  "claude-opus-4-20250514": {
    name: "Claude Opus 4",
    input: 15.0,
    output: 75.0,
    cache_write_5m: 18.75,
    cache_write_1h: 30.0,
    cache_read: 1.5,
  },
  "claude-opus-4-1": {
    name: "Claude Opus 4.1",
    input: 15.0,
    output: 75.0,
    cache_write_5m: 18.75,
    cache_write_1h: 30.0,
    cache_read: 1.5,
  },
  "claude-opus-4-1-20250805": {
    name: "Claude Opus 4.1",
    input: 15.0,
    output: 75.0,
    cache_write_5m: 18.75,
    cache_write_1h: 30.0,
    cache_read: 1.5,
  },
  "claude-sonnet-4-20250514": {
    name: "Claude Sonnet 4",
    input: 3.0,
    output: 15.0,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
    cache_read: 0.3,
  },
  "claude-4-opus-20250514": {
    name: "Claude 4 Opus",
    input: 15.0,
    output: 75.0,
    cache_write_5m: 18.75,
    cache_write_1h: 30.0,
    cache_read: 1.5,
  },
  "claude-4-sonnet-20250514": {
    name: "Claude 4 Sonnet",
    input: 3.0,
    output: 15.0,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
    cache_read: 0.3,
  },
  "claude-sonnet-4-5": {
    name: "Claude Sonnet 4.5",
    input: 3.0,
    output: 15.0,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
    cache_read: 0.3,
  },
  "claude-sonnet-4-5-20250929": {
    name: "Claude Sonnet 4.5",
    input: 3.0,
    output: 15.0,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
    cache_read: 0.3,
  },
  "claude-opus-4-5": {
    name: "Claude Opus 4.5",
    input: 5.0,
    output: 25.0,
    cache_write_5m: 6.25,
    cache_write_1h: 10.0,
    cache_read: 0.5,
  },
  "claude-opus-4-5-20251101": {
    name: "Claude Opus 4.5",
    input: 5.0,
    output: 25.0,
    cache_write_5m: 6.25,
    cache_write_1h: 10.0,
    cache_read: 0.5,
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    input: 5.0,
    output: 25.0,
    cache_write_5m: 6.25,
    cache_write_1h: 10.0,
    cache_read: 0.5,
  },
  "claude-opus-4-6-20260205": {
    name: "Claude Opus 4.6",
    input: 5.0,
    output: 25.0,
    cache_write_5m: 6.25,
    cache_write_1h: 10.0,
    cache_read: 0.5,
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    input: 3.0,
    output: 15.0,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
    cache_read: 0.3,
  },
};

// [LAW:effects-at-boundaries] What prices a transcript entry that carries no
// cost of its own: the one table its owner loads. The daemon is handed one as
// an adapter over its own closing signal, so a load in flight at the close
// ends with the close, and a daemon under test is handed the bundled table and
// reaches no network.
export interface Pricing {
  // [LAW:no-silent-failure] Never rejects: a load that cannot reach a table
  // prices by the bundled rates, and says why on the owner's log.
  table(): Promise<PriceTable>;
}

// The bundled rates, with no I/O.
export function offlinePricing(): Pricing {
  return { table: async () => OFFLINE_PRICING_DATA };
}

const PRICING_URL = new URL(
  "https://raw.githubusercontent.com/promptctl/cc-candybar/main/pricing.json",
);
const DISK_TTL_MS = 24 * 60 * 60 * 1000;

interface LiveOwner {
  // The home's cache directory, where the day's table is kept on disk.
  readonly cacheRoot: string;
  readonly clock: Pick<Timekeeper, "now">;
  // [LAW:single-enforcer] The owner's one close: after it, no load starts and
  // none writes.
  readonly closing: AbortSignal;
  readonly log: DaemonLogger;
}

// [LAW:single-enforcer] One load per owner, however many entries ask while it
// is out: every un-costed entry of every fold awaits the same table, so a cold
// cache costs one fetch and one disk write, not one per entry. The day's disk
// copy is read first; a fetch that fails, or a close that ends it, prices by
// the bundled rates.
export function livePricing(owner: LiveOwner): Pricing {
  let loading: Promise<PriceTable> | null = null;
  return {
    table: () =>
      owner.closing.aborted
        ? Promise.resolve(OFFLINE_PRICING_DATA)
        : (loading ??= loadTable(owner).catch((e: unknown) => {
            // [LAW:single-enforcer] The one place "never rejects" holds: a
            // throw anywhere in the load is kept as the bundled rates, and
            // said, so a fold never fails on its price.
            owner.log("error", `pricing load threw: ${String(e)}`);
            return OFFLINE_PRICING_DATA;
          })),
  };
}

const diskPath = (cacheRoot: string): string =>
  path.join(cacheRoot, "usage", "pricing.json");

async function loadTable(owner: LiveOwner): Promise<PriceTable> {
  const cached = await readDisk(owner);
  if (cached !== null) return cached;
  const fresh = owner.closing.aborted
    ? null
    : await fetchPricingData(owner.closing);
  if (fresh === null) {
    debug(
      `[CACHE-FALLBACK] Using offline pricing data: ${Object.keys(OFFLINE_PRICING_DATA).length} models`,
    );
    return OFFLINE_PRICING_DATA;
  }
  // A close ends the owner's writes too: the next daemon fetches again.
  if (!owner.closing.aborted) await writeDisk(owner, fresh);
  return fresh;
}

// The day's copy, or null for none: a missing, stale, unreadable or malformed
// file is a miss, and the table is fetched.
async function readDisk(owner: LiveOwner): Promise<PriceTable | null> {
  try {
    const stored = JSON.parse(
      await fs.promises.readFile(diskPath(owner.cacheRoot), "utf8"),
    ) as { data?: unknown; timestamp?: unknown };
    const fresh =
      typeof stored.timestamp === "number" &&
      stored.timestamp >= owner.clock.now() - DISK_TTL_MS;
    return fresh && validatePricingData(stored.data) ? stored.data : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      owner.log("warn", `pricing disk cache unreadable: ${String(e)}`);
    }
    return null;
  }
}

// [LAW:no-ambient-temporal-coupling] A renamed whole file is the only write a
// reader can see, so no lock is held and no reader waits: two daemons writing
// the day's table leave one of their two whole copies.
async function writeDisk(owner: LiveOwner, table: PriceTable): Promise<void> {
  const file = diskPath(owner.cacheRoot);
  const staged = `${file}.${process.pid}.${randomUUID()}`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(
      staged,
      JSON.stringify({ data: table, timestamp: owner.clock.now() }),
      "utf8",
    );
    await fs.promises.rename(staged, file);
  } catch (e) {
    // The fetched table still prices: a copy that is not kept costs the next
    // daemon a fetch.
    owner.log("warn", `pricing disk cache not written: ${String(e)}`);
    await fs.promises.rm(staged, { force: true }).catch(() => {});
  }
}

// [LAW:no-ambient-temporal-coupling] `agent: false` gives the request a
// connection of its own that ends with its response: a pooled keep-alive socket
// would outlive the owner's close, and nothing would end it. `signal` is the
// owner's close.
export function fetchPricingData(
  closing: AbortSignal,
): Promise<PriceTable | null> {
  return new Promise((resolve) => {
    const request = get(
      {
        hostname: PRICING_URL.hostname,
        path: PRICING_URL.pathname,
        headers: {
          "User-Agent": "cc-candybar",
          "Cache-Control": "no-cache",
        },
        timeout: 5000,
        agent: false,
        signal: closing,
      },
      (response) => {
        if (response.statusCode !== 200) {
          debug(`HTTP ${response.statusCode}: ${response.statusMessage}`);
          response.resume();
          resolve(null);
          return;
        }

        let data = "";
        let size = 0;
        const MAX_SIZE = 1024 * 1024;

        // A multi-byte character can straddle two reads; the response's own
        // decoder holds the partial bytes until the rest arrive. The cap is in
        // bytes, so a decoded chunk is measured by its encoded size.
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_SIZE) {
            debug("Response too large");
            request.destroy();
            resolve(null);
            return;
          }
          data += chunk;
        });

        response.on("end", () => {
          try {
            const json = JSON.parse(data) as Record<string, unknown>;
            const meta = json._meta as { updated?: string } | undefined;

            const pricingData: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(json)) {
              if (key !== "_meta") {
                pricingData[key] = value;
              }
            }

            if (validatePricingData(pricingData)) {
              debug(
                `Fetched fresh pricing from GitHub for ${Object.keys(pricingData).length} models`,
              );
              debug(`Pricing last updated: ${meta?.updated || "unknown"}`);
              resolve(pricingData);
            } else {
              debug("Invalid pricing data structure");
              resolve(null);
            }
          } catch (error) {
            debug("Failed to parse JSON:", error);
            resolve(null);
          }
        });

        response.on("error", (error) => {
          debug("Response error:", error);
          resolve(null);
        });
      },
    );

    request.on("error", (error) => {
      debug("Request error:", error);
      resolve(null);
    });

    request.on("timeout", () => {
      debug("Request timeout");
      request.destroy();
      resolve(null);
    });

    request.end();
  });
}

function validatePricingData(data: unknown): data is PriceTable {
  if (!data || typeof data !== "object") return false;

  for (const [, value] of Object.entries(data)) {
    if (!value || typeof value !== "object") return false;
    const pricing = value as Record<string, unknown>;

    // Every rate the cost reads: a table missing one would price entries as
    // NaN.
    if (
      typeof pricing.input !== "number" ||
      typeof pricing.output !== "number" ||
      typeof pricing.cache_read !== "number" ||
      typeof pricing.cache_write_5m !== "number"
    ) {
      return false;
    }
  }

  return true;
}

function modelPricingOf(modelId: string, allPricing: PriceTable): ModelPricing {
  const exact = allPricing[modelId];
  if (exact) return exact;
  const lowerModelId = modelId.toLowerCase();

  for (const [key, pricing] of Object.entries(allPricing)) {
    if (key.toLowerCase() === lowerModelId) {
      return pricing;
    }
  }
  const patterns = [
    {
      pattern: ["opus-4-6", "claude-opus-4-6"],
      fallback: "claude-opus-4-6-20260205",
    },
    {
      pattern: ["opus-4-5", "claude-opus-4-5"],
      fallback: "claude-opus-4-5-20251101",
    },
    {
      pattern: ["opus-4-1", "claude-opus-4-1"],
      fallback: "claude-opus-4-1-20250805",
    },
    {
      pattern: ["opus-4", "claude-opus-4"],
      fallback: "claude-opus-4-20250514",
    },
    {
      pattern: ["sonnet-4-6", "sonnet-4.6", "claude-sonnet-4-6"],
      fallback: "claude-sonnet-4-6",
    },
    {
      pattern: ["sonnet-4.5", "4-5-sonnet", "sonnet-4-5"],
      fallback: "claude-sonnet-4-5-20250929",
    },
    {
      pattern: ["sonnet-4", "claude-sonnet-4"],
      fallback: "claude-sonnet-4-20250514",
    },
    {
      pattern: ["haiku-4.5", "4-5-haiku", "haiku-4-5"],
      fallback: "claude-haiku-4-5-20251001",
    },
    { pattern: ["haiku"], fallback: "claude-haiku-4-5-20251001" },
    { pattern: ["opus"], fallback: "claude-opus-4-20250514" },
    { pattern: ["sonnet"], fallback: "claude-sonnet-4-5-20250929" },
  ];

  for (const { pattern, fallback } of patterns) {
    if (pattern.some((p) => lowerModelId.includes(p))) {
      if (allPricing[fallback]) {
        return allPricing[fallback];
      }
    }
  }

  return (
    allPricing["claude-sonnet-4-5-20250929"] || {
      name: `${modelId} (Unknown Model)`,
      input: 3.0,
      cache_write_5m: 3.75,
      cache_write_1h: 6.0,
      cache_read: 0.3,
      output: 15.0,
    }
  );
}

// [LAW:dataflow-not-control-flow] An entry's cost is its usage at its model's
// rates in the table: a pure function of the two.
export function costOf(table: PriceTable, entry: PrunedRaw): number {
  const usage = entry.message?.usage;
  if (!usage) {
    return 0;
  }

  const pricing = modelPricingOf(modelIdOf(entry), table);

  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cache_read;
  const cacheCreationCost =
    (cacheCreationTokens / 1_000_000) * pricing.cache_write_5m;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

function modelIdOf(entry: Record<string, unknown>): string {
  if (entry.model && typeof entry.model === "string") {
    return entry.model;
  }

  const message = entry.message as Record<string, unknown> | undefined;
  if (message?.model) {
    const model = message.model;
    if (typeof model === "string") {
      return model;
    }
    const modelObj = model as Record<string, unknown> | undefined;
    return (
      (typeof modelObj?.id === "string" ? modelObj.id : null) ||
      "claude-sonnet-4-5-20250929"
    );
  }

  if (entry.model_id && typeof entry.model_id === "string") {
    return entry.model_id;
  }

  return "claude-sonnet-4-5-20250929";
}
