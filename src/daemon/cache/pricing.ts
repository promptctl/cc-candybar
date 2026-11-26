// The price table: the rates an entry Claude Code wrote without a cost is
// priced at, and the one owner that loads the table, retries it and
// refreshes it.

import fs from "node:fs";
import path from "node:path";

import type { PrunedRaw } from "../../utils/claude.js";
import { publishByRenameAsync } from "../../utils/atomic-write";
import type { DaemonLogger } from "../../utils/logger";
import { valueOf } from "../../utils/logfmt";
import { failed, ok, type Failed, type Ok } from "../../utils/outcome";
import { backedOffMs, type Every } from "../../utils/period";
import type { RefreshLedger, Refreshes } from "../../utils/refresh-ledger";
import {
  entries,
  number,
  object,
  read,
  text,
  type Shape,
} from "../../utils/wire-shape";
import { elapsedMs, type Timekeeper } from "../../time";

// [LAW:types-are-the-program] Exactly the rates a cost reads, in dollars per
// million tokens. Every table, fetched or read back from disk, is parsed to
// this shape, so a table lacking one is refused rather than pricing as NaN.
export interface ModelRates {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write_5m: number;
}

const RATES: Shape<ModelRates> = object<ModelRates>({
  input: number,
  output: number,
  cache_read: number,
  cache_write_5m: number,
});
const MODELS = entries<Readonly<Record<string, ModelRates>>>(text, RATES);

// What the cache file holds: the last fetched table's models and when it was
// fetched.
interface CacheFile {
  readonly data: Readonly<Record<string, ModelRates>>;
  readonly timestamp: number;
}
const CACHE_FILE: Shape<CacheFile> = object<CacheFile>({
  data: MODELS,
  timestamp: number,
});

const HAIKU_4_5: ModelRates = {
  input: 1,
  output: 5,
  cache_write_5m: 1.25,
  cache_read: 0.1,
};
const SONNET_4: ModelRates = {
  input: 3,
  output: 15,
  cache_write_5m: 3.75,
  cache_read: 0.3,
};
const OPUS_4: ModelRates = {
  input: 15,
  output: 75,
  cache_write_5m: 18.75,
  cache_read: 1.5,
};
const OPUS_4_5: ModelRates = {
  input: 5,
  output: 25,
  cache_write_5m: 6.25,
  cache_read: 0.5,
};

// What prices while no fetched table or cache file stands.
const BUNDLED: Readonly<Record<string, ModelRates>> = {
  "claude-haiku-4-5-20251001": HAIKU_4_5,
  "claude-haiku-4-5": HAIKU_4_5,
  "claude-opus-4-20250514": OPUS_4,
  "claude-opus-4-1": OPUS_4,
  "claude-opus-4-1-20250805": OPUS_4,
  "claude-sonnet-4-20250514": SONNET_4,
  "claude-4-opus-20250514": OPUS_4,
  "claude-4-sonnet-20250514": SONNET_4,
  "claude-sonnet-4-5": SONNET_4,
  "claude-sonnet-4-5-20250929": SONNET_4,
  "claude-opus-4-5": OPUS_4_5,
  "claude-opus-4-5-20251101": OPUS_4_5,
  "claude-opus-4-6": OPUS_4_5,
  "claude-opus-4-6-20260205": OPUS_4_5,
  "claude-sonnet-4-6": SONNET_4,
};

// The model an entry naming none is priced as, and the one a model no table
// names falls back to.
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

// A model id no entry of a table matches is priced as the model of the first
// family whose names it contains.
interface Family {
  readonly names: readonly string[];
  readonly model: string;
}
const FAMILIES: readonly Family[] = [
  { names: ["opus-4-6"], model: "claude-opus-4-6-20260205" },
  { names: ["opus-4-5"], model: "claude-opus-4-5-20251101" },
  { names: ["opus-4-1"], model: "claude-opus-4-1-20250805" },
  { names: ["opus-4"], model: "claude-opus-4-20250514" },
  { names: ["sonnet-4-6", "sonnet-4.6"], model: "claude-sonnet-4-6" },
  {
    names: ["sonnet-4.5", "4-5-sonnet", "sonnet-4-5"],
    model: "claude-sonnet-4-5-20250929",
  },
  { names: ["sonnet-4"], model: "claude-sonnet-4-20250514" },
  {
    names: ["haiku-4.5", "4-5-haiku", "haiku-4-5"],
    model: "claude-haiku-4-5-20251001",
  },
  { names: ["haiku"], model: "claude-haiku-4-5-20251001" },
  { names: ["opus"], model: "claude-opus-4-20250514" },
  { names: ["sonnet"], model: "claude-sonnet-4-5-20250929" },
];

// [LAW:one-source-of-truth] A table answers each model's rates, and what it
// resolved for a model is kept inside it: a table that replaces it brings its
// own, so a model already priced is priced by the table that stands now.
export class PriceTable {
  private readonly resolved = new Map<string, ModelRates>();

  constructor(readonly models: ReadonlyMap<string, ModelRates>) {}

  ratesOf(model: string): ModelRates {
    const known = this.resolved.get(model);
    if (known !== undefined) return known;
    const rates = this.resolve(model);
    this.resolved.set(model, rates);
    return rates;
  }

  private resolve(model: string): ModelRates {
    const exact = this.models.get(model);
    if (exact !== undefined) return exact;
    const lower = model.toLowerCase();
    for (const [name, rates] of this.models) {
      if (name.toLowerCase() === lower) return rates;
    }
    for (const { names, model: family } of FAMILIES) {
      const rates = this.models.get(family);
      if (rates !== undefined && names.some((n) => lower.includes(n))) {
        return rates;
      }
    }
    return this.models.get(DEFAULT_MODEL) ?? SONNET_4;
  }
}

export function bundledTable(): PriceTable {
  return new PriceTable(new Map(Object.entries(BUNDLED)));
}

// What an entry is priced at by a table.
export function costOf(table: PriceTable, raw: PrunedRaw): number {
  const usage = raw.message?.usage;
  if (usage === undefined) return 0;
  const rates = table.ratesOf(raw.model ?? raw.message?.model ?? DEFAULT_MODEL);
  return (
    ((usage.input_tokens ?? 0) * rates.input +
      (usage.output_tokens ?? 0) * rates.output +
      (usage.cache_creation_input_tokens ?? 0) * rates.cache_write_5m +
      (usage.cache_read_input_tokens ?? 0) * rates.cache_read) /
    1_000_000
  );
}

function parsedJson(body: string): Ok<unknown> | Failed {
  try {
    return ok(JSON.parse(body) as unknown);
  } catch (e) {
    return failed(`not JSON: ${String(e)}`, "parse");
  }
}

// [LAW:parse-dont-validate] The one parse of a table's models, fetched or
// read back: a model lacking a finite number for any rate a cost reads
// refuses the whole table, and so does a table naming no model.
function tableOf(models: unknown): Ok<PriceTable> | Failed {
  const parsed = read(MODELS, models);
  if (parsed.kind === "missed") {
    return failed(
      `no rate at ${parsed.at.map((at) => at || "<table>").join(", ")}`,
      "parse",
    );
  }
  return checkedTable(parsed.value);
}

function checkedTable(
  models: Readonly<Record<string, ModelRates>>,
): Ok<PriceTable> | Failed {
  const table = new Map(Object.entries(models));
  return table.size === 0
    ? failed("the table names no model", "parse")
    : ok(new PriceTable(table));
}

// The remote file heads its models with `_meta`, which names no model.
function fetchedTable(body: string): Ok<PriceTable> | Failed {
  const json = parsedJson(body);
  if (json.kind === "failed") return json;
  if (
    typeof json.value !== "object" ||
    json.value === null ||
    Array.isArray(json.value)
  ) {
    return tableOf(json.value);
  }
  const { _meta: _, ...models } = json.value as Record<string, unknown>;
  return tableOf(models);
}

// A cache file's table, and the wall time it was fetched at.
interface Cached {
  readonly table: PriceTable;
  readonly timestamp: number;
}

function cachedTable(body: string): Ok<Cached> | Failed {
  const json = parsedJson(body);
  if (json.kind === "failed") return json;
  const file = read(CACHE_FILE, json.value);
  if (file.kind === "missed") {
    return failed(
      `not a cache file: ${file.at.map((at) => at || "<file>").join(", ")}`,
      "parse",
    );
  }
  const table = checkedTable(file.value.data);
  return table.kind === "failed"
    ? table
    : ok({ table: table.value, timestamp: file.value.timestamp });
}

// [LAW:effects-at-boundaries] The remote file's body, or why there is none.
// The signal is the owner's close: an aborted fetch holds no socket.
export type FetchPricing = (
  signal: AbortSignal,
) => Promise<Ok<string> | Failed>;

// What a fold prices by.
export type Prices = Pick<Pricing, "table">;

// Where the table that stands came from: what a load's line names, so a cost
// that looks wrong says what priced it.
type TableSource = "fetched" | "cache" | "bundled";

interface Standing {
  readonly table: PriceTable;
  readonly source: TableSource;
  // The monotonic time the next load is due at: a loaded table's day, or a failed
  // load's backoff.
  readonly dueAt: number;
  // Loads in a row that ended without a table.
  readonly failures: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// A loaded table lasts a day. A failed load is tried again after a minute,
// doubling per failure in a row up to an hour.
const EVERY: Every = { okMs: DAY_MS, failedMs: 60_000 };
const BACKOFF_CEILING_MS = 60 * 60_000;

type LoadTrigger = "first" | "period";

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// [LAW:single-enforcer] The daemon's one price table: one load at a time,
// shared by every asker while it is out, retried after a failure and
// refreshed once its day is up. A load never rejects: what it could not read
// is its outcome, and the asker gets the table that stands.
export class Pricing {
  private standing: Standing | null = null;
  private loading: Promise<PriceTable> | null = null;
  private readonly closing = new AbortController();
  private readonly refreshes: Refreshes<LoadTrigger>;

  constructor(
    private readonly opts: {
      readonly fetch: FetchPricing;
      // The cache file: the last fetched table, read back at the next start.
      readonly cache: string;
      // [LAW:effects-at-boundaries] The daemon's clock: a table's day and a
      // retry's backoff are measured on it, so a test holds both.
      readonly clock: Pick<Timekeeper, "now" | "monotonic" | "detach">;
      readonly ledger: RefreshLedger;
      readonly logger: DaemonLogger;
    },
  ) {
    this.refreshes = opts.ledger.declare<LoadTrigger>({
      name: "pricing",
      scope: "daemon",
      refresh: ["first", "period"],
      lines: ["first", "period"],
    });
  }

  // The table that prices now. Only an ask before any table stands waits, for
  // the first load; every later ask is answered by the standing table at once.
  table(): Promise<PriceTable> {
    const standing = this.standing;
    if (standing === null) return this.load("first");
    // [LAW:single-enforcer] exception: the table is refreshed when an ask
    // finds it due, not on a period of its own. Only folds ask, and they run
    // only on the periods and watches of entries a session holds, so a
    // daemon no session holds fetches nothing and arms nothing.
    if (this.opts.clock.monotonic() >= standing.dueAt) {
      this.opts.clock.detach("pricing refresh", () => this.load("period"));
    }
    return Promise.resolve(standing.table);
  }

  // [LAW:no-ambient-temporal-coupling] Ends the load in flight and settles
  // once it has, so a settled close leaves no fetch, read or write of
  // pricing's running.
  async close(): Promise<void> {
    this.closing.abort();
    await this.loading;
  }

  private load(by: LoadTrigger): Promise<PriceTable> {
    this.loading ??= this.loaded(by).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loaded(by: LoadTrigger): Promise<PriceTable> {
    const { signal } = this.closing;
    const prior = this.standing;
    if (signal.aborted) return prior?.table ?? bundledTable();
    const started = this.opts.clock.monotonic();
    const { standing, outcome } = await this.attempt(prior, signal);
    const ms = elapsedMs(this.opts.clock, started);
    // [LAW:no-silent-failure] A load the close ended is its own event, never
    // a failure of the table, and what it answered stands for nothing.
    if (signal.aborted) {
      this.refreshes.abandoned("-", by, ms);
      return prior?.table ?? bundledTable();
    }
    this.standing = standing;
    this.refreshes.recorded(
      `prices=${standing.source} dueInMs=${standing.dueAt - this.opts.clock.monotonic()}`,
      by,
      outcome,
      ms,
    );
    return standing.table;
  }

  // A fresh cache file is the table; otherwise the remote file, written to
  // the cache once parsed. A fetch that fails leaves the table that stood,
  // else a stale cache file, else the bundled rates.
  private async attempt(
    prior: Standing | null,
    signal: AbortSignal,
  ): Promise<{
    readonly standing: Standing;
    readonly outcome: Ok<unknown> | Failed;
  }> {
    let cached: Cached | null = null;
    try {
      // The disk copy seeds a new owner. Once this owner has a table, its
      // monotonic deadline decides when to fetch, even after a wall-clock change.
      cached = prior === null ? await this.readCache(signal) : null;
      const now = this.opts.clock.now();
      if (
        cached !== null &&
        cached.timestamp <= now &&
        now < cached.timestamp + DAY_MS
      ) {
        return {
          standing: {
            table: cached.table,
            source: "cache",
            dueAt:
              this.opts.clock.monotonic() + (DAY_MS - (now - cached.timestamp)),
            failures: 0,
          },
          outcome: ok(null),
        };
      }
      // A close during the read starts no fetch.
      if (signal.aborted) {
        return {
          standing: this.fellBack(prior, cached),
          outcome: failed("closed", "read"),
        };
      }
      const body = await this.opts.fetch(signal);
      const fetched = body.kind === "ok" ? fetchedTable(body.value) : body;
      if (fetched.kind === "ok") {
        await this.writeCache(fetched.value, signal);
        return {
          standing: {
            table: fetched.value,
            source: "fetched",
            dueAt: this.opts.clock.monotonic() + DAY_MS,
            failures: 0,
          },
          outcome: fetched,
        };
      }
      return { standing: this.fellBack(prior, cached), outcome: fetched };
    } catch (e) {
      // [LAW:no-silent-failure] A throw is a bug the load reports as its
      // outcome, so the asker still gets a table.
      return {
        standing: this.fellBack(prior, cached),
        outcome: failed(`pricing load threw: ${errorText(e)}`, "read"),
      };
    }
  }

  private fellBack(prior: Standing | null, cached: Cached | null): Standing {
    const failures = (prior?.failures ?? 0) + 1;
    const kept =
      prior ??
      (cached === null
        ? { table: bundledTable(), source: "bundled" as const }
        : { table: cached.table, source: "cache" as const });
    return {
      table: kept.table,
      source: kept.source,
      dueAt:
        this.opts.clock.monotonic() +
        backedOffMs(EVERY, failures, BACKOFF_CEILING_MS),
      failures,
    };
  }

  // The cache file's table and when it was fetched, or null for a file that
  // is not there or could not be read; a refused one is logged.
  private async readCache(signal: AbortSignal): Promise<Cached | null> {
    const file = this.opts.cache;
    let body: string;
    try {
      body = await fs.promises.readFile(file, { encoding: "utf8", signal });
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing && !signal.aborted) this.warn("unreadable", file, e);
      return null;
    }
    const cached = cachedTable(body);
    if (cached.kind === "ok") return cached.value;
    this.warn("refused", file, cached.reason);
    return null;
  }

  // [LAW:no-ambient-temporal-coupling] The close's signal is read before the
  // directory is made and before the file is published, so a table that
  // lands after the close writes nothing.
  private async writeCache(
    table: PriceTable,
    signal: AbortSignal,
  ): Promise<void> {
    const file = this.opts.cache;
    try {
      if (signal.aborted) return;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      if (signal.aborted) return;
      const written: CacheFile = {
        data: Object.fromEntries(table.models),
        timestamp: this.opts.clock.now(),
      };
      await publishByRenameAsync(
        file,
        JSON.stringify(written),
        undefined,
        signal,
      );
    } catch (e) {
      if (!signal.aborted) this.warn("unwritable", file, e);
    }
  }

  private warn(state: string, file: string, why: unknown): void {
    this.opts.logger(
      "warn",
      `pricing cache ${state} path=${valueOf(file)} reason=${valueOf(errorText(why))}`,
    );
  }
}
