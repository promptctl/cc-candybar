import { debug } from "../utils/logger";
import { get } from "node:https";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { Timekeeper } from "../time";
import type { DaemonLogger } from "../utils/logger";
import type { PrunedRaw } from "../utils/claude.js";
import { stagedPath } from "../utils/staged-path.js";
import { backedOffMs, type Every } from "../utils/period";

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
  // prices by the table held, or by the bundled rates before any landed, and
  // says why on the owner's log.
  table(): Promise<PriceTable>;
}

// The bundled rates, with no I/O.
export function offlinePricing(): Pricing {
  return { table: async () => OFFLINE_PRICING_DATA };
}

const PRICING_URL = new URL(
  "https://raw.githubusercontent.com/promptctl/cc-candybar/main/pricing.json",
);

// [LAW:one-source-of-truth] The one schedule a table is loaded again on. A
// table that landed is good for a day, and the day's disk copy is fresh for
// the same day; a load that landed nothing is tried again after a backoff that
// doubles per failure in a row, up to the ceiling.
export const PRICING_PERIOD: Every = {
  okMs: 24 * 60 * 60 * 1000,
  failedMs: 30_000,
};
export const PRICING_RETRY_CEILING_MS = 60 * 60 * 1000;

interface LiveOwner {
  // The home's cache directory, where the day's table is kept on disk.
  readonly cacheRoot: string;
  readonly clock: Pick<Timekeeper, "now">;
  // [LAW:single-enforcer] The owner's one close: after it, no load starts and
  // none writes.
  readonly closing: AbortSignal;
  readonly log: DaemonLogger;
}

// A table that landed, and the wall moment it was read: the disk copy's
// timestamp, or when the fetch answered.
interface Landed {
  readonly kind: "landed";
  readonly table: PriceTable;
  readonly at: number;
}

// A load that landed nothing: when it settled, how many in a row have (this
// one included), and the last table that did land, if one ever did.
interface Failed {
  readonly kind: "failed";
  readonly at: number;
  readonly failures: number;
  readonly last: Landed | null;
}

// [LAW:types-are-the-program] What the owner holds once a load has settled.
// What prices, and when the next load is due, are read off it, never stored
// beside it: a failed load's `last` says whether a table ever landed, so
// nothing compares a table against the bundled one.
type Held = Landed | Failed;

const lastLanded = (held: Held | null): Landed | null =>
  held === null ? null : held.kind === "landed" ? held : held.last;

// The bundled rates price until a table lands.
const tableOf = (held: Held): PriceTable =>
  lastLanded(held)?.table ?? OFFLINE_PRICING_DATA;

const failuresOf = (held: Held): number =>
  held.kind === "landed" ? 0 : held.failures;

// How long what a load settled stands: a day for a landed table, the backoff
// for a failed one.
const standsMs = (failures: number): number =>
  backedOffMs(PRICING_PERIOD, failures, PRICING_RETRY_CEILING_MS);

// [LAW:single-enforcer] THE moment a held value is loaded again. The disk copy
// is judged by it too, so the day ends once.
const due = (held: Held, now: number): boolean =>
  held.at + standsMs(failuresOf(held)) <= now;

// [LAW:single-enforcer] One load per owner, however many entries ask while it
// is out: every un-costed entry of every fold awaits the same table, so a cold
// cache costs one fetch and one disk write, not one per entry.
// [LAW:dataflow-not-control-flow] Every ask takes the same step: the one load
// starts when what is held is due, and the ask is answered with what is held.
// Before anything settled the ask awaits that load; afterwards it answers at
// once and the load lands behind it, so neither a day's end nor a retry stalls
// a fold, and a load that lands nothing leaves the last table standing.
// [LAW:no-ambient-temporal-coupling] No timer is armed: the retry is the next
// ask after the due moment, so the close has nothing to cancel.
export function livePricing(owner: LiveOwner): Pricing {
  let held: Held | null = null;
  let loading: Promise<Held> | null = null;
  return {
    table: () => {
      const owed = held === null || due(held, owner.clock.now());
      if (owed && !owner.closing.aborted) {
        loading ??= loadHeld(owner, held).then((settled) => {
          held = settled;
          loading = null;
          return settled;
        });
      }
      if (held !== null) return Promise.resolve(tableOf(held));
      // Nothing settled and no load out: the owner closed before any did.
      return loading === null
        ? Promise.resolve(OFFLINE_PRICING_DATA)
        : loading.then(tableOf);
    },
  };
}

// One load, and what the owner holds after it. [LAW:no-silent-failure] Never
// rejects: a throw anywhere in the load is a load that landed nothing, and is
// said, so a fold never fails on its price.
async function loadHeld(owner: LiveOwner, prev: Held | null): Promise<Held> {
  const landed = await loadTable(owner).catch((e: unknown) => {
    owner.log("error", `pricing load threw: ${String(e)}`);
    return null;
  });
  if (landed !== null) return landed;
  const failed: Failed = {
    kind: "failed",
    at: owner.clock.now(),
    failures: (prev === null ? 0 : failuresOf(prev)) + 1,
    last: lastLanded(prev),
  };
  owner.log(
    "warn",
    `pricing table not loaded (${failed.failures} in a row): priced by ${failed.last === null ? "the bundled rates" : "the last table"} until a retry in ${standsMs(failed.failures)}ms`,
  );
  return failed;
}

const diskPath = (cacheRoot: string): string =>
  path.join(cacheRoot, "usage", "pricing.json");

// The disk copy while it is the day's, else a fetch; null for a load that
// landed nothing.
async function loadTable(owner: LiveOwner): Promise<Landed | null> {
  const copy = await readDisk(owner);
  if (copy !== null && !due(copy, owner.clock.now())) return copy;
  const fresh = owner.closing.aborted
    ? null
    : await fetchPricingData(owner.closing);
  if (fresh === null) return null;
  const landed: Landed = {
    kind: "landed",
    table: fresh,
    at: owner.clock.now(),
  };
  // A close ends the owner's writes too: the next daemon fetches again.
  if (!owner.closing.aborted) await writeDisk(owner, landed);
  return landed;
}

// The copy on disk, whatever its age, or null for none: a missing, unreadable
// or malformed file is no copy.
async function readDisk(owner: LiveOwner): Promise<Landed | null> {
  try {
    const { data, timestamp } = JSON.parse(
      await fs.promises.readFile(diskPath(owner.cacheRoot), "utf8"),
    ) as { data?: unknown; timestamp?: unknown };
    if (typeof timestamp !== "number" || !validatePricingData(data)) {
      return null;
    }
    return { kind: "landed", table: data, at: timestamp };
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
async function writeDisk(owner: LiveOwner, landed: Landed): Promise<void> {
  const file = diskPath(owner.cacheRoot);
  const staged = stagedPath(file);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(
      staged,
      JSON.stringify({ data: landed.table, timestamp: landed.at }),
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
