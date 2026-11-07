import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import {
  costOf,
  livePricing,
  offlinePricing,
  PRICING_PERIOD,
  type PriceTable,
} from "../src/segments/pricing";
import type { DaemonLogger } from "../src/utils/logger";
import { heldClock, type HeldClock } from "./helpers/held-clock";
import { jestTmpDir } from "./helpers/jest-tmp";
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
  const first = pricing.table();
  await asking(1);
  asked[0]!.answer(RATES);
  expect(await first).toEqual(RATES);
  return pricing;
}

describe("a daemon's pricing", () => {
  test("every entry that asks while the table is out shares one fetch", async () => {
    const pricing = live();
    const tables = [pricing.table(), pricing.table(), pricing.table()];
    await asking();
    asked[0]!.answer(RATES);

    const [first, ...rest] = await Promise.all(tables);
    expect(first).toEqual(RATES);
    for (const table of rest) expect(table).toBe(first);
    expect(asked).toHaveLength(1);
  });

  test("the day's copy on disk is read by the next daemon, which fetches nothing", async () => {
    await loaded();

    expect(await live().table()).toEqual(RATES);
    expect(asked).toHaveLength(1);
  });

  test("a copy on disk missing a rate the cost reads is a miss, and the table is fetched", async () => {
    const { cache_write_5m: _dropped, ...partial } = RATES["model-x"]!;
    fs.mkdirSync(path.join(cacheRoot, "usage"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({ data: { "model-x": partial }, timestamp: clock.now() }),
    );

    const table = live().table();
    await asking();
    asked[0]!.answer(RATES);
    expect(await table).toEqual(RATES);
  });

  test("a copy that cannot be written still prices by the fetched table, and says so", async () => {
    // A directory nothing can be written into: the read finds no copy, and
    // the write fails.
    const usage = path.join(cacheRoot, "usage");
    fs.mkdirSync(usage);
    fs.chmodSync(usage, 0o500);

    const table = live().table();
    await asking();
    asked[0]!.answer(RATES);

    expect(await table).toEqual(RATES);
    expect(warnings).toEqual([
      expect.stringContaining("pricing disk cache not written"),
    ]);
  });

  test("its request holds no pooled connection, and the owner's close ends a load in flight on the bundled rates", async () => {
    const pricing = live();
    const table = pricing.table();
    await asking();
    expect(asked[0]!.options.agent).toBe(false);

    closing.abort();

    expect(await table).toEqual(await offlinePricing().table());
    expect(fs.existsSync(path.join(cacheRoot, "usage", "pricing.json"))).toBe(
      false,
    );
  });

  test("a load that throws prices by the bundled rates, and says so", async () => {
    getThrows = new Error("bad options");

    expect(await live().table()).toEqual(await offlinePricing().table());
    expect(warnings).toEqual([
      "pricing load threw: Error: bad options",
      expect.stringContaining("pricing table not loaded (1 in a row)"),
    ]);
  });

  test("after the owner's close, no load starts", async () => {
    closing.abort();

    expect(await live().table()).toEqual(await offlinePricing().table());
    expect(asked).toHaveLength(0);
  });

  test("a load that landed nothing is tried again after a backoff that doubles per failure, and the table that then lands prices", async () => {
    const bundled = await offlinePricing().table();
    const pricing = live();
    const first = pricing.table();
    await asking(1);
    asked[0]!.fail();
    expect(await first).toEqual(bundled);
    expect(warnings).toEqual([
      `pricing table not loaded (1 in a row): priced by the bundled rates; the next ask after ${PRICING_PERIOD.failedMs}ms tries again`,
    ]);

    // Before the backoff is up, an ask starts nothing.
    clock.advance(PRICING_PERIOD.failedMs - 1);
    expect(await pricing.table()).toEqual(bundled);
    await noFetchPast(1);

    // At the backoff, the ask is answered by what is held and the retry
    // starts behind it.
    clock.advance(1);
    expect(await pricing.table()).toEqual(bundled);
    await asking(2);
    asked[1]!.fail();
    await until(() => warnings.length === 2, "the second failure said");
    expect(warnings[1]).toBe(
      `pricing table not loaded (2 in a row): priced by the bundled rates; the next ask after ${2 * PRICING_PERIOD.failedMs}ms tries again`,
    );

    // The second backoff is twice the first.
    clock.advance(PRICING_PERIOD.failedMs);
    expect(await pricing.table()).toEqual(bundled);
    await noFetchPast(2);
    clock.advance(PRICING_PERIOD.failedMs);
    expect(await pricing.table()).toEqual(bundled);
    await asking(3);

    asked[2]!.answer(RATES);
    await until(
      async () => "model-x" in (await pricing.table()),
      "the fetched table held",
    );
    expect(await pricing.table()).toEqual(RATES);
    expect(diskCopy()).toEqual({ data: RATES, timestamp: clock.now() });
  });

  test("a loaded table is fetched again once its day is up, and prices until the new one lands", async () => {
    const pricing = await loaded();

    clock.advance(PRICING_PERIOD.okMs - 1);
    expect(await pricing.table()).toEqual(RATES);
    await noFetchPast(1);

    // The day is up: the old table answers, and one fetch starts behind it,
    // however many ask while it is out.
    clock.advance(1);
    expect(await pricing.table()).toEqual(RATES);
    await asking(2);
    expect(await pricing.table()).toEqual(RATES);
    expect(await pricing.table()).toEqual(RATES);
    await noFetchPast(2);

    asked[1]!.answer(NEXT_RATES);
    await until(
      async () => "model-y" in (await pricing.table()),
      "the next day's table held",
    );
    expect(await pricing.table()).toEqual(NEXT_RATES);
    expect(diskCopy()).toEqual({ data: NEXT_RATES, timestamp: clock.now() });
    expect(warnings).toEqual([]);
  });

  test("a refresh that lands nothing keeps the loaded table, says so, and is tried again after the backoff rather than another day", async () => {
    const pricing = await loaded();

    clock.advance(PRICING_PERIOD.okMs);
    expect(await pricing.table()).toEqual(RATES);
    await asking(2);
    asked[1]!.fail();
    await until(() => warnings.length === 1, "the failed refresh said");
    expect(warnings[0]).toBe(
      `pricing table not loaded (1 in a row): priced by the last table; the next ask after ${PRICING_PERIOD.failedMs}ms tries again`,
    );
    expect(await pricing.table()).toEqual(RATES);

    clock.advance(PRICING_PERIOD.failedMs);
    expect(await pricing.table()).toEqual(RATES);
    await asking(3);
  });

  test("a refresh takes the day's copy another daemon wrote, and fetches nothing", async () => {
    const pricing = await loaded();

    clock.advance(PRICING_PERIOD.okMs);
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({ data: NEXT_RATES, timestamp: clock.now() }),
    );

    expect(await pricing.table()).toEqual(RATES);
    await until(
      async () => "model-y" in (await pricing.table()),
      "the copy on disk held",
    );
    expect(asked).toHaveLength(1);
  });

  test("a close during a refresh keeps the loaded table, writes nothing and is no failure, and after it no load starts", async () => {
    const pricing = await loaded();
    const written = diskCopy();

    clock.advance(PRICING_PERIOD.okMs);
    expect(await pricing.table()).toEqual(RATES);
    await asking(2);
    closing.abort();

    expect(await pricing.table()).toEqual(RATES);
    expect(diskCopy()).toEqual(written);
    clock.advance(PRICING_PERIOD.failedMs);
    expect(await pricing.table()).toEqual(RATES);
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
    const first = pricing.table();
    await asking(1);
    asked[0]!.fail();
    expect(await first).toEqual(RATES);
    expect(warnings).toEqual([
      `pricing table not loaded (1 in a row): priced by the last table; the next ask after ${PRICING_PERIOD.failedMs}ms tries again`,
    ]);

    clock.advance(PRICING_PERIOD.failedMs);
    expect(await pricing.table()).toEqual(RATES);
    await asking(2);
    asked[1]!.answer(NEXT_RATES);
    await until(
      async () => "model-y" in (await pricing.table()),
      "the fetched table held",
    );
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
    expect(await pricing.table()).toEqual(RATES);
    await asking(2);
    asked[1]!.fail();
    await until(() => warnings.length === 1, "the failed refresh said");
    expect(await pricing.table()).toEqual(RATES);
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

    const table = live().table();
    await asking(1);
    asked[0]!.answer(NEXT_RATES);
    expect(await table).toEqual(NEXT_RATES);
    expect(diskCopy()).toEqual({ data: NEXT_RATES, timestamp: clock.now() });
  });

  test("an entry's cost is its usage at its model's rates", () => {
    const entry = {
      message: {
        model: "model-x",
        usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
      },
    };
    expect(costOf(RATES, entry as never)).toBe(1 + 1);
  });
});
