import { EventEmitter } from "node:events";
import fs from "node:fs";
import { Readable } from "node:stream";

import {
  costOf,
  livePricing,
  offlinePricing,
  type PriceTable,
} from "../src/segments/pricing";
import { systemTimekeeper } from "../src/time";
import { jestTmpDir } from "./helpers/jest-tmp";

// The one seam is the network: each `get` is recorded with its options, and
// answers only when the case says, so a load can be caught in flight.
interface Asked {
  readonly options: { agent?: unknown; signal?: AbortSignal };
  answer(body: unknown): void;
}
let asked: Asked[] = [];

jest.mock("node:https", () => ({
  get: (
    options: Asked["options"],
    onResponse: (response: Readable) => void,
  ) => {
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
const turns = () => new Promise((turn) => setImmediate(turn));
const until = async (met: () => boolean) => {
  while (!met()) await turns();
};

let cacheRoot: string;
beforeEach(() => {
  asked = [];
  cacheRoot = jestTmpDir("cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
});
afterEach(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));

describe("a daemon's pricing", () => {
  test("every entry that asks while the table is out shares one fetch", async () => {
    const pricing = livePricing({ cacheRoot, clock: systemTimekeeper });
    const tables = [pricing.table(), pricing.table(), pricing.table()];
    await until(() => asked.length > 0);
    asked[0]!.answer(RATES);

    const [first, ...rest] = await Promise.all(tables);
    expect(first).toEqual(RATES);
    for (const table of rest) expect(table).toBe(first);
    expect(asked).toHaveLength(1);
  });

  test("its request holds no pooled connection, and its close ends a load in flight on the bundled rates", async () => {
    const pricing = livePricing({ cacheRoot, clock: systemTimekeeper });
    const table = pricing.table();
    await until(() => asked.length > 0);
    expect(asked[0]!.options.agent).toBe(false);

    pricing.close();

    expect(await table).toEqual(await offlinePricing().table());
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
