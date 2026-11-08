import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { reaction } from "mobx";

import { SessionUsageStore } from "../src/daemon/cache/session-usage-store";
import {
  livePricing,
  offlinePricing,
  priceOf,
  PRICING_PERIOD,
  PRICING_RETRY_CEILING_MS,
  type PriceTable,
} from "../src/segments/pricing";
import type { TokenBreakdown } from "../src/segments/session";
import type { ClaudeHookData } from "../src/utils/claude";
import { Holds } from "../src/utils/holds";
import { instantOf, type Instant } from "../src/utils/instant";
import { backedOffMs } from "../src/utils/period";
import type { DaemonLogger } from "../src/utils/logger";
import { heldClock, type HeldClock } from "./helpers/held-clock";
import { HOST } from "./helpers/host";
import { jestTmpDir } from "./helpers/jest-tmp";
import { todayInfo, todayNow } from "./helpers/today";
import { throughout, until } from "./helpers/until";

// The one seam is the network: each `get` is recorded with its options, and
// answers, or fails, only when the case says, so a load can be caught in
// flight.
interface Asked {
  readonly options: { agent?: unknown; signal?: AbortSignal };
  answer(body: unknown): void;
  fail(): void;
}
let asked: Asked[] = [];
// A `get` that throws as it is called, as node's does on options it refuses.
let getThrows: Error | null = null;

jest.mock("node:https", () => ({
  get: (
    options: Asked["options"],
    onResponse: (response: Readable) => void,
  ) => {
    if (getThrows !== null) throw getThrows;
    const request = Object.assign(new EventEmitter(), {
      end: () => {},
      destroy: () => {},
    });
    options.signal?.addEventListener("abort", () =>
      request.emit("error", options.signal?.reason),
    );
    asked.push({
      options,
      answer: (body) => {
        const response = Object.assign(new Readable({ read() {} }), {
          statusCode: 200,
          statusMessage: "OK",
        });
        onResponse(response);
        response.push(Buffer.from(JSON.stringify(body)));
        response.push(null);
      },
      fail: () => request.emit("error", new Error("offline")),
    });
    return request;
  },
}));

const RATES: PriceTable = {
  "model-x": {
    name: "X",
    input: 1,
    output: 2,
    cache_read: 3,
    cache_write_5m: 4,
    cache_write_1h: 5,
  },
};
// The next day's table: a model the first did not carry.
const NEXT_RATES: PriceTable = {
  "model-y": {
    name: "Y",
    input: 6,
    output: 7,
    cache_read: 8,
    cache_write_5m: 9,
    cache_write_1h: 10,
  },
};
// A later day's table: the first's model at ten times its rates.
const RAISED_RATES: PriceTable = {
  "model-x": {
    name: "X",
    input: 10,
    output: 20,
    cache_read: 30,
    cache_write_5m: 40,
    cache_write_1h: 50,
  },
};
const BUNDLED = offlinePricing().table();
const warnings: string[] = [];
const log: DaemonLogger = (_level, message) => void warnings.push(message);
// The n-th fetch has been asked for.
const asking = (n = 1) => until(() => asked.length >= n, `pricing fetch ${n}`);
// A real-time hold: a load the case says must not start has had the disk read
// and the loop turns it would need to reach the network.
const noFetchPast = (n: number) =>
  throughout(() => asked.length === n, `no fetch past the ${n}th`, 200);
const diskCopy = () =>
  JSON.parse(
    fs.readFileSync(path.join(cacheRoot, "usage", "pricing.json"), "utf8"),
  ) as { data: PriceTable; timestamp: number };
// The table `pricing` reads has `model` in it: a load has settled on it.
const holding = (pricing: { table(): PriceTable }, model: string) =>
  until(() => model in pricing.table(), `the table with ${model} held`);

let cacheRoot: string;
let closing: AbortController;
let clock: HeldClock;
const live = () =>
  livePricing({
    cacheRoot,
    clock,
    closing: closing.signal,
    log,
  });
beforeEach(() => {
  asked = [];
  getThrows = null;
  warnings.length = 0;
  closing = new AbortController();
  clock = heldClock(new Date());
  cacheRoot = jestTmpDir("cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
});
afterEach(() => {
  fs.chmodSync(cacheRoot, 0o700);
  const usage = path.join(cacheRoot, "usage");
  if (fs.existsSync(usage)) fs.chmodSync(usage, 0o700);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// A first load that lands RATES, so the case starts from a held table.
async function loaded() {
  const pricing = live();
  pricing.ask();
  await asking(1);
  asked[0]!.answer(RATES);
  await holding(pricing, "model-x");
  return pricing;
}

describe("a daemon's pricing", () => {
  test("however many ask while the table is out, one fetch starts, and the bundled rates price until it lands", async () => {
    const pricing = live();
    pricing.ask();
    pricing.ask();
    pricing.ask();
    await asking();
    expect(pricing.table()).toBe(BUNDLED);
    asked[0]!.answer(RATES);

    await holding(pricing, "model-x");
    expect(pricing.table()).toEqual(RATES);
    expect(asked).toHaveLength(1);
  });

  test("a derivation over the table is recomputed in the turn one lands", async () => {
    const pricing = live();
    const seen: PriceTable[] = [];
    const stop = reaction(
      () => pricing.table(),
      (table) => seen.push(table),
    );
    try {
      pricing.ask();
      await asking();
      asked[0]!.answer(RATES);
      await until(() => seen.length === 1, "the reaction ran");
      expect(seen[0]).toEqual(RATES);
    } finally {
      stop();
    }
  });

  test("a derivation over the table is left standing by a refresh that lands nothing", async () => {
    const pricing = await loaded();
    const seen: PriceTable[] = [];
    const stop = reaction(
      () => pricing.table(),
      (table) => seen.push(table),
    );
    try {
      clock.advance(PRICING_PERIOD.okMs);
      pricing.ask();
      await asking(2);
      asked[1]!.fail();
      await until(() => warnings.length === 1, "the failed refresh said");
      // What the failed load holds is the day's copy of the table already
      // priced by, read from disk again: no table moved, so nothing over it.
      await throughout(
        () => seen.length === 0,
        "the derivation left standing",
        200,
      );
      expect(pricing.table()).toEqual(RATES);
    } finally {
      stop();
    }
  });

  test("the day's copy on disk prices the next daemon from its start, before anything asks, and an ask fetches nothing", async () => {
    await loaded();

    const next = live();
    await holding(next, "model-x");
    expect(next.table()).toEqual(RATES);
    next.ask();
    await noFetchPast(1);
  });

  test("a copy past its day prices a daemon from its start, and nothing is fetched until it asks", async () => {
    fs.mkdirSync(path.join(cacheRoot, "usage"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({
        data: RATES,
        timestamp: clock.now() - PRICING_PERIOD.okMs,
      }),
    );

    const pricing = live();
    await holding(pricing, "model-x");
    await noFetchPast(0);
    pricing.ask();
    await asking(1);
    asked[0]!.answer(NEXT_RATES);
    await holding(pricing, "model-y");
  });

  test("a load that rejects is said in the owner's log, and the next ask starts another", async () => {
    let clockThrows = false;
    const pricing = livePricing({
      cacheRoot,
      clock: {
        now: () => {
          if (clockThrows) throw new Error("clock gone");
          return clock.now();
        },
      },
      closing: closing.signal,
      log,
    });
    pricing.ask();
    await asking(1);
    // The failed load reads the clock to stamp its failure, outside the
    // load's own catches.
    clockThrows = true;
    asked[0]!.fail();
    await until(() => warnings.length === 1, "the rejection said");
    expect(warnings).toEqual(["pricing load rejected: Error: clock gone"]);
    expect(pricing.table()).toBe(BUNDLED);

    clockThrows = false;
    await until(
      () => {
        pricing.ask();
        return asked.length === 2;
      },
      "the next load started",
    );
  });

  test("a copy on disk missing a rate the cost reads is a miss, and the table is fetched", async () => {
    const { cache_write_5m: _dropped, ...partial } = RATES["model-x"]!;
    fs.mkdirSync(path.join(cacheRoot, "usage"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({ data: { "model-x": partial }, timestamp: clock.now() }),
    );

    const pricing = live();
    pricing.ask();
    await asking();
    asked[0]!.answer(RATES);
    await holding(pricing, "model-x");
    expect(pricing.table()).toEqual(RATES);
  });

  test("a copy that cannot be written still prices by the fetched table, and says so", async () => {
    // A directory nothing can be written into: the read finds no copy, and
    // the write fails.
    const usage = path.join(cacheRoot, "usage");
    fs.mkdirSync(usage);
    fs.chmodSync(usage, 0o500);

    const pricing = live();
    pricing.ask();
    await asking();
    asked[0]!.answer(RATES);

    await holding(pricing, "model-x");
    expect(pricing.table()).toEqual(RATES);
    expect(warnings).toEqual([
      expect.stringContaining("pricing disk cache not written"),
    ]);
  });

  test("its request holds no pooled connection, and the owner's close ends a load in flight on the bundled rates", async () => {
    const pricing = live();
    pricing.ask();
    await asking();
    expect(asked[0]!.options.agent).toBe(false);

    closing.abort();

    await throughout(
      () => pricing.table() === BUNDLED,
      "the bundled rates stand",
      200,
    );
    expect(fs.existsSync(path.join(cacheRoot, "usage", "pricing.json"))).toBe(
      false,
    );
  });

  test("a load that throws prices by the bundled rates, and says so", async () => {
    getThrows = new Error("bad options");

    const pricing = live();
    pricing.ask();
    await until(() => warnings.length === 2, "the failed load said");
    expect(pricing.table()).toBe(BUNDLED);
    expect(warnings).toEqual([
      "pricing load threw: Error: bad options",
      expect.stringContaining(
        "pricing table not loaded: priced by the bundled rates",
      ),
    ]);
  });

  test("after the owner's close, no load starts", async () => {
    closing.abort();

    const pricing = live();
    pricing.ask();
    expect(pricing.table()).toBe(BUNDLED);
    await noFetchPast(0);
  });

  test("a load that landed nothing is tried again after a backoff that doubles per failure, and the table that then lands prices", async () => {
    const pricing = live();
    pricing.ask();
    await asking(1);
    asked[0]!.fail();
    await until(() => warnings.length === 1, "the first failure said");
    expect(pricing.table()).toBe(BUNDLED);
    expect(warnings).toEqual([
      `pricing table not loaded: priced by the bundled rates; the next ask after ${PRICING_PERIOD.failedMs}ms tries again`,
    ]);

    // Before the backoff is up, an ask starts nothing.
    clock.advance(PRICING_PERIOD.failedMs - 1);
    pricing.ask();
    expect(pricing.table()).toBe(BUNDLED);
    await noFetchPast(1);

    // At the backoff, the retry starts; the bundled rates price meanwhile.
    clock.advance(1);
    pricing.ask();
    expect(pricing.table()).toBe(BUNDLED);
    await asking(2);
    asked[1]!.fail();
    await until(() => warnings.length === 2, "the second failure said");
    expect(warnings[1]).toBe(
      `pricing table not loaded: priced by the bundled rates; the next ask after ${2 * PRICING_PERIOD.failedMs}ms tries again`,
    );

    // The second backoff is twice the first.
    clock.advance(PRICING_PERIOD.failedMs);
    pricing.ask();
    expect(pricing.table()).toBe(BUNDLED);
    await noFetchPast(2);
    clock.advance(PRICING_PERIOD.failedMs);
    pricing.ask();
    expect(pricing.table()).toBe(BUNDLED);
    await asking(3);

    asked[2]!.answer(RATES);
    await holding(pricing, "model-x");
    expect(pricing.table()).toEqual(RATES);
    expect(diskCopy()).toEqual({ data: RATES, timestamp: clock.now() });
  });

  test("a loaded table is fetched again once its day is up, and prices until the new one lands", async () => {
    const pricing = await loaded();

    clock.advance(PRICING_PERIOD.okMs - 1);
    pricing.ask();
    expect(pricing.table()).toEqual(RATES);
    await noFetchPast(1);

    // The day is up: the old table answers, and one fetch starts behind it,
    // however many ask while it is out.
    clock.advance(1);
    pricing.ask();
    expect(pricing.table()).toEqual(RATES);
    await asking(2);
    pricing.ask();
    pricing.ask();
    expect(pricing.table()).toEqual(RATES);
    await noFetchPast(2);

    asked[1]!.answer(NEXT_RATES);
    await holding(pricing, "model-y");
    expect(pricing.table()).toEqual(NEXT_RATES);
    expect(diskCopy()).toEqual({ data: NEXT_RATES, timestamp: clock.now() });
    expect(warnings).toEqual([]);
  });

  test("a refresh that lands nothing keeps the loaded table, says so, and is tried again after the backoff rather than another day", async () => {
    const pricing = await loaded();

    clock.advance(PRICING_PERIOD.okMs);
    pricing.ask();
    await asking(2);
    asked[1]!.fail();
    await until(() => warnings.length === 1, "the failed refresh said");
    expect(warnings[0]).toBe(
      `pricing table not loaded: priced by the last table; the next ask after ${PRICING_PERIOD.failedMs}ms tries again`,
    );
    expect(pricing.table()).toEqual(RATES);

    clock.advance(PRICING_PERIOD.failedMs);
    pricing.ask();
    expect(pricing.table()).toEqual(RATES);
    await asking(3);
  });

  test("a refresh takes the day's copy another daemon wrote, and fetches nothing", async () => {
    const pricing = await loaded();

    clock.advance(PRICING_PERIOD.okMs);
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({ data: NEXT_RATES, timestamp: clock.now() }),
    );

    pricing.ask();
    expect(pricing.table()).toEqual(RATES);
    await holding(pricing, "model-y");
    expect(asked).toHaveLength(1);
  });

  test("a close during a refresh keeps the loaded table, writes nothing and is no failure, and after it no load starts", async () => {
    const pricing = await loaded();
    const written = diskCopy();

    clock.advance(PRICING_PERIOD.okMs);
    pricing.ask();
    await asking(2);
    closing.abort();

    expect(pricing.table()).toEqual(RATES);
    expect(diskCopy()).toEqual(written);
    clock.advance(PRICING_PERIOD.failedMs);
    pricing.ask();
    expect(pricing.table()).toEqual(RATES);
    await noFetchPast(2);
    expect(warnings).toEqual([]);
  });

  test("a daemon that starts on a copy past its day with no network prices by that copy, not the bundled rates", async () => {
    fs.mkdirSync(path.join(cacheRoot, "usage"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({
        data: RATES,
        timestamp: clock.now() - PRICING_PERIOD.okMs,
      }),
    );

    const pricing = live();
    pricing.ask();
    await asking(1);
    asked[0]!.fail();
    await until(() => warnings.length === 1, "the failed load said");
    expect(pricing.table()).toEqual(RATES);
    expect(warnings).toEqual([
      `pricing table not loaded: priced by the last table; the next ask after ${PRICING_PERIOD.failedMs}ms tries again`,
    ]);

    clock.advance(PRICING_PERIOD.failedMs);
    pricing.ask();
    expect(pricing.table()).toEqual(RATES);
    await asking(2);
    asked[1]!.answer(NEXT_RATES);
    await holding(pricing, "model-y");
  });

  test("a machine with no network says each backoff once, and falls silent at the ceiling", async () => {
    const pricing = live();
    pricing.ask();
    // The backoff grows for eight failures and stands at the ceiling from the
    // eighth on.
    for (let n = 1; n <= 8; n++) {
      await asking(n);
      asked[n - 1]!.fail();
      await until(() => warnings.length === n, `failure ${n} said`);
      clock.advance(backedOffMs(PRICING_PERIOD, n, PRICING_RETRY_CEILING_MS));
      // The failure settles a turn after it is said, and an ask before that
      // finds the load still out; ask until the retry has started.
      await until(
        () => {
          pricing.ask();
          return asked.length > n;
        },
        `load ${n + 1} started`,
      );
    }
    expect(warnings[7]).toBe(
      `pricing table not loaded: priced by the bundled rates; the next ask after ${PRICING_RETRY_CEILING_MS}ms tries again`,
    );
    expect(new Set(warnings).size).toBe(8);

    // The ninth says nothing new.
    await asking(9);
    asked[8]!.fail();
    await throughout(
      () => warnings.length === 8,
      "the ninth failure said nothing",
      200,
    );
  });

  test("a close during the first load on a copy past its day prices by that copy, and says nothing", async () => {
    fs.mkdirSync(path.join(cacheRoot, "usage"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({
        data: RATES,
        timestamp: clock.now() - PRICING_PERIOD.okMs,
      }),
    );

    const pricing = live();
    pricing.ask();
    await asking(1);
    closing.abort();
    await holding(pricing, "model-x");
    expect(pricing.table()).toEqual(RATES);
    expect(warnings).toEqual([]);
  });

  test("a refresh that lands nothing keeps the later of the held table and the copy on disk", async () => {
    const pricing = await loaded();
    // A copy an earlier daemon wrote, left when this owner's write did not land.
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({
        data: NEXT_RATES,
        timestamp: clock.now() - 2 * PRICING_PERIOD.okMs,
      }),
    );

    clock.advance(PRICING_PERIOD.okMs);
    pricing.ask();
    await asking(2);
    asked[1]!.fail();
    await until(() => warnings.length === 1, "the failed refresh said");
    await throughout(
      () => "model-x" in pricing.table(),
      "the held table stands",
      200,
    );
  });

  test("a copy stamped ahead of the clock is no copy: the table is fetched and the copy rewritten", async () => {
    fs.mkdirSync(path.join(cacheRoot, "usage"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({
        data: RATES,
        timestamp: clock.now() + 7 * PRICING_PERIOD.okMs,
      }),
    );

    const pricing = live();
    pricing.ask();
    await asking(1);
    asked[0]!.answer(NEXT_RATES);
    await holding(pricing, "model-y");
    expect(diskCopy()).toEqual({ data: NEXT_RATES, timestamp: clock.now() });
  });

  test("a model's tokens cost its rates in the table", () => {
    const tokens: TokenBreakdown = {
      input: 1_000_000,
      output: 500_000,
      cacheCreation: 0,
      cacheRead: 0,
    };
    expect(priceOf(RATES, "model-x", tokens)).toBe(1 + 1);
  });
});

// One transcript line of `model-x` usage with no cost of its own, dated `at`.
function unpricedLine(tag: string, at: number): string {
  return (
    JSON.stringify({
      timestamp: new Date(at).toISOString(),
      requestId: `req-${tag}`,
      message: {
        id: `msg-${tag}`,
        model: "model-x",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    }) + "\n"
  );
}
const MILLION_IN: TokenBreakdown = {
  input: 1_000_000,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
};

describe("a daemon that folded entries before its table landed", () => {
  let holds: Holds;
  beforeEach(() => {
    holds = new Holds();
  });
  afterEach(() => {
    holds.close();
  });

  // The session's cost and the day `at` falls in as the draw reads them, with
  // no refresh.
  function drawn(store: SessionUsageStore, hd: ClaudeHookData, at: Instant) {
    const session = store.usageOf(hd.session_id, hd);
    const today = todayNow(store, holds, hd, cacheRoot, at);
    return {
      session: session.kind === "ok" ? session.value.session.cost : session,
      today: today.kind === "ok" ? today.value.cost : today,
    };
  }

  test("prices them by the table when it lands, with no byte read again, and again when the day's table lands", async () => {
    // Two entries of a model the bundled rates do not name, folded while the
    // first fetch is out: each is priced as the default model until a table
    // lands, which is distinct from every table a fetch answers here.
    const at = instantOf(new Date(clock.now()));
    const transcript = path.join(cacheRoot, "transcripts", "S.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(
      transcript,
      unpricedLine("a", clock.now()) + unpricedLine("b", clock.now()),
    );
    const hd = {
      session_id: "S",
      transcript_path: transcript,
    } as ClaudeHookData;
    const pricing = live();
    const store = new SessionUsageStore({
      host: HOST,
      pricing,
      clock,
      sweepIntervalMs: 0,
    });
    try {
      const bundledPrice = 2 * priceOf(BUNDLED, "model-x", MILLION_IN);
      const first = await store.getUsageInfo("S", hd);
      expect(first).toMatchObject({
        value: { session: { cost: bundledPrice } },
      });
      await asking(1);
      const today = await todayInfo(store, holds, hd, cacheRoot, at);
      expect(today).toMatchObject({
        kind: "ok",
        value: { cost: bundledPrice },
      });
      expect(drawn(store, hd, at)).toEqual({
        session: bundledPrice,
        today: bundledPrice,
      });
      const { misses } = store.getStats();

      // The table lands. Nothing is written to the transcript, nothing is
      // refreshed: the draw reads the landed table's price.
      asked[0]!.answer(RATES);
      await holding(pricing, "model-x");
      expect(drawn(store, hd, at)).toEqual({ session: 2, today: 2 });

      // The day is up: the next request asks, the table that lands prices.
      clock.advance(PRICING_PERIOD.okMs);
      await store.getUsageInfo("S", hd);
      await asking(2);
      asked[1]!.answer(RAISED_RATES);
      await until(
        () => pricing.table()["model-x"]?.input === 10,
        "the raised table held",
      );
      expect(drawn(store, hd, at)).toEqual({ session: 20, today: 20 });
      expect(store.getStats().misses).toBe(misses);
    } finally {
      store.close();
    }
  });
});
