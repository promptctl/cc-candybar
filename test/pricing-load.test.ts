import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import {
  costOf,
  livePricing,
  offlinePricing,
  type PriceTable,
} from "../src/segments/pricing";
import { systemTimekeeper } from "../src/time";
import type { DaemonLogger } from "../src/utils/logger";
import { jestTmpDir } from "./helpers/jest-tmp";
import { until } from "./helpers/until";

// The one seam is the network: each `get` is recorded with its options, and
// answers only when the case says, so a load can be caught in flight.
interface Asked {
  readonly options: { agent?: unknown; signal?: AbortSignal };
  answer(body: unknown): void;
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
const warnings: string[] = [];
const log: DaemonLogger = (_level, message) => void warnings.push(message);
const asking = () => until(() => asked.length > 0, "the pricing fetch");

let cacheRoot: string;
let closing: AbortController;
const live = () =>
  livePricing({
    cacheRoot,
    clock: systemTimekeeper,
    closing: closing.signal,
    log,
  });
beforeEach(() => {
  asked = [];
  getThrows = null;
  warnings.length = 0;
  closing = new AbortController();
  cacheRoot = jestTmpDir("cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
});
afterEach(() => {
  fs.chmodSync(cacheRoot, 0o700);
  const usage = path.join(cacheRoot, "usage");
  if (fs.existsSync(usage)) fs.chmodSync(usage, 0o700);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

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
    const first = live().table();
    await asking();
    asked[0]!.answer(RATES);
    await first;

    expect(await live().table()).toEqual(RATES);
    expect(asked).toHaveLength(1);
  });

  test("a copy on disk missing a rate the cost reads is a miss, and the table is fetched", async () => {
    const { cache_write_5m: _dropped, ...partial } = RATES["model-x"]!;
    fs.mkdirSync(path.join(cacheRoot, "usage"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "usage", "pricing.json"),
      JSON.stringify({ data: { "model-x": partial }, timestamp: Date.now() }),
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
    expect(warnings).toEqual(["pricing load threw: Error: bad options"]);
  });

  test("after the owner's close, no load starts", async () => {
    closing.abort();

    expect(await live().table()).toEqual(await offlinePricing().table());
    expect(asked).toHaveLength(0);
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
