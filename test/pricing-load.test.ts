// [LAW:verifiable-goals] The price table's owner, over a held clock, a
// scripted network and a real cache file: one load shared by every asker, a
// failure that is a value and never a rejection, a retry on backoff, a
// refresh once a table's day is up, and a close that ends every load and
// write.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  costOf,
  Pricing,
  type FetchPricing,
  type PriceTable,
} from "../src/daemon/cache/pricing";
import { failed, ok, type Failed, type Ok } from "../src/utils/outcome";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import { heldClock } from "./helpers/held-clock";

const START = new Date("2026-11-24T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A model only a fetched table names: the bundled rates price it as the
// default model, at $3 per million input tokens.
const FETCHED_ONLY = "claude-fetched-9";
const rates = (input: number) => ({
  input,
  output: 5 * input,
  cache_write_5m: 1.25 * input,
  cache_read: input / 10,
});
const remote = (models: Record<string, unknown>): string =>
  JSON.stringify({ _meta: { updated: "2026-11-22" }, ...models });
const REMOTE_7 = remote({ [FETCHED_ONLY]: rates(7) });

// What a table prices a million tokens of one kind at, for `model`.
const perMillion = (
  table: PriceTable,
  model: string,
  kind: "input_tokens" | "cache_creation_input_tokens" = "input_tokens",
): number =>
  costOf(table, { model, message: { model, usage: { [kind]: 1_000_000 } } });

interface Asked {
  readonly signal: AbortSignal;
  readonly answer: (body: Ok<string> | Failed) => void;
}

// The network, scripted: each fetch waits until the case answers it, or, as
// the real one does, until its signal aborts. One that ignores the abort is a
// body landing in the turn the close begins.
function network(endsOnAbort: boolean) {
  const asked: Asked[] = [];
  const waiting: Array<(call: Asked) => void> = [];
  const fetch: FetchPricing = (signal) =>
    new Promise((answer) => {
      const call = { signal, answer };
      asked.push(call);
      const aborted = () => answer(failed("aborted", "read"));
      if (endsOnAbort && signal.aborted) aborted();
      if (endsOnAbort)
        signal.addEventListener("abort", aborted, { once: true });
      waiting.shift()?.(call);
    });
  // The next fetch asked from now on: taken before the ask that makes it.
  const next = () => new Promise<Asked>((resolve) => waiting.push(resolve));
  return { fetch, asked, next };
}

let dir: string;
const owners: Pricing[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-pricing-"));
});

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig({
  cache = path.join(dir, "usage", "pricing.json"),
  endsOnAbort = true,
}: { readonly cache?: string; readonly endsOnAbort?: boolean } = {}) {
  const net = network(endsOnAbort);
  const clock = heldClock(START);
  const lines: string[] = [];
  const loads: Array<(line: string) => void> = [];
  const logger = (level: string, msg: string) => {
    lines.push(`${level} ${msg}`);
    if (msg.startsWith("pricing refresh")) loads.shift()?.(msg);
  };
  const ledger = new RefreshLedger(logger);
  // [LAW:verifiable-goals] A load's first step is its read of the cache file,
  // made in the turn the load starts, so a count of them says whether an ask
  // started a load before the load could fetch anything.
  const readFile = jest.spyOn(fs.promises, "readFile");
  const pricing = new Pricing({
    fetch: net.fetch,
    cache,
    clock,
    ledger,
    logger,
  });
  owners.push(pricing);
  return {
    pricing,
    net,
    clock,
    lines,
    cache,
    reads: () => readFile.mock.calls.filter(([file]) => file === cache).length,
    // The line the next load to settle writes.
    nextLoad: () => new Promise<string>((resolve) => loads.push(resolve)),
    record: () => ledger.snapshot().find(({ name }) => name === "pricing")!,
  };
}

type Rig = ReturnType<typeof rig>;

// The first load, its fetch answered with `body`.
async function firstLoad(r: Rig, body: Ok<string> | Failed) {
  const fetched = r.net.next();
  const line = r.nextLoad();
  const table = r.pricing.table();
  (await fetched).answer(body);
  return { table: await table, line: await line };
}

function writeCache(file: string, models: object, timestamp: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ data: models, timestamp }));
}

describe("the price table's first load", () => {
  test("askers before it lands share it: one cache read, one fetch, one table", async () => {
    const r = rig();
    const fetched = r.net.next();
    const asks = [r.pricing.table(), r.pricing.table(), r.pricing.table()];
    (await fetched).answer(ok(REMOTE_7));
    const [first, ...rest] = await Promise.all(asks);

    for (const table of rest) expect(table).toBe(first);
    expect(perMillion(first!, FETCHED_ONLY)).toBe(7);
    expect(r.reads()).toBe(1);
    expect(r.net.asked).toHaveLength(1);
  });

  test.each([
    ["offline", failed("getaddrinfo ENOTFOUND", "read")],
    ["answered with an error status", failed("HTTP 503 Unavailable", "read")],
    ["answered with something other than JSON", ok("<html>busy</html>")],
    [
      "answered with a table lacking cache_write_5m",
      ok(remote({ [FETCHED_ONLY]: { input: 7, output: 35, cache_read: 0.7 } })),
    ],
  ])(
    "a fetch %s settles on the bundled rates, as a failure, and nothing prices to NaN",
    async (_, body) => {
      const r = rig();
      const { table, line } = await firstLoad(r, body);

      expect(
        perMillion(table, FETCHED_ONLY, "cache_creation_input_tokens"),
      ).toBe(3.75);
      expect(line).toContain("prices=bundled");
      expect(line).toContain("outcome=failed");
      expect(r.record()).toMatchObject({ failures: 1 });
      expect(fs.existsSync(r.cache)).toBe(false);
    },
  );

  test("a refused table's reason names the model and the rate it lacks", async () => {
    const r = rig();
    const { line } = await firstLoad(
      r,
      ok(remote({ [FETCHED_ONLY]: { input: 7, output: 35, cache_read: 0.7 } })),
    );

    expect(line).toContain(`${FETCHED_ONLY}.cache_write_5m`);
  });

  test("a fetched table is written to the cache file, which the next owner prices by with no fetch", async () => {
    const first = rig();
    await firstLoad(first, ok(REMOTE_7));
    const next = rig({ cache: first.cache });

    const table = await next.pricing.table();

    expect(perMillion(table, FETCHED_ONLY)).toBe(7);
    expect(next.net.asked).toHaveLength(0);
  });
});

describe("the cache file", () => {
  test("a fresh one is the table, with no fetch, due at the end of its day", async () => {
    const r = rig();
    writeCache(r.cache, { [FETCHED_ONLY]: rates(7) }, START.getTime() - HOUR);
    const line = r.nextLoad();

    const table = await r.pricing.table();

    expect(perMillion(table, FETCHED_ONLY)).toBe(7);
    expect(r.net.asked).toHaveLength(0);
    expect(await line).toContain(`prices=cache dueInMs=${DAY - HOUR}`);
  });

  test("a cache timestamp ahead of the clock cannot postpone a fetch", async () => {
    const r = rig();
    writeCache(r.cache, { [FETCHED_ONLY]: rates(4) }, START.getTime() + DAY);
    const { table } = await firstLoad(r, ok(REMOTE_7));
    expect(perMillion(table, FETCHED_ONLY)).toBe(7);
  });

  test("a stale one is fetched over, and stands while the fetch fails", async () => {
    const r = rig();
    writeCache(r.cache, { [FETCHED_ONLY]: rates(7) }, START.getTime() - DAY);

    const { table, line } = await firstLoad(r, failed("offline", "read"));

    expect(perMillion(table, FETCHED_ONLY)).toBe(7);
    expect(line).toContain("prices=cache");
    expect(line).toContain("outcome=failed");
  });

  test("a stale one is replaced by a table that lands", async () => {
    const r = rig();
    writeCache(r.cache, { [FETCHED_ONLY]: rates(7) }, START.getTime() - DAY);

    const { table } = await firstLoad(
      r,
      ok(remote({ [FETCHED_ONLY]: rates(9) })),
    );

    expect(perMillion(table, FETCHED_ONLY)).toBe(9);
    expect(JSON.parse(fs.readFileSync(r.cache, "utf8"))).toMatchObject({
      timestamp: START.getTime(),
      data: { [FETCHED_ONLY]: rates(9) },
    });
  });

  test("one lacking a rate is refused, said, and fetched over", async () => {
    const r = rig();
    writeCache(
      r.cache,
      { [FETCHED_ONLY]: { input: 7, output: 35, cache_read: 0.7 } },
      START.getTime(),
    );

    const { table } = await firstLoad(r, ok(REMOTE_7));

    expect(perMillion(table, FETCHED_ONLY, "cache_creation_input_tokens")).toBe(
      8.75,
    );
    expect(r.lines.join("\n")).toMatch(
      /^warn pricing cache refused .*cache_write_5m/m,
    );
  });

  test("one that cannot be read settles on a table without rejecting", async () => {
    const r = rig();
    // A directory where the file belongs: the read fails, and not as missing.
    fs.mkdirSync(r.cache, { recursive: true });

    const { table } = await firstLoad(r, ok(REMOTE_7));

    expect(perMillion(table, FETCHED_ONLY)).toBe(7);
    expect(r.lines.join("\n")).toMatch(/^warn pricing cache unreadable /m);
  });

  test("one that cannot be written settles on a table without rejecting", async () => {
    // Its directory's parent is a file, so the directory cannot be made.
    fs.writeFileSync(path.join(dir, "usage"), "");
    const r = rig();

    const { table, line } = await firstLoad(r, ok(REMOTE_7));

    expect(perMillion(table, FETCHED_ONLY)).toBe(7);
    expect(line).toContain("outcome=ok");
    expect(r.lines.join("\n")).toMatch(/^warn pricing cache unwritable /m);
  });
});

describe("a failed load is tried again", () => {
  test("not before its backoff; once it is up, while the bundled rates still answer; and a table that lands prices from then on", async () => {
    const r = rig();
    const { line } = await firstLoad(r, failed("offline", "read"));
    expect(line).toContain(`dueInMs=${MINUTE}`);

    r.clock.advance(MINUTE - 1);
    await r.pricing.table();
    expect(r.net.asked).toHaveLength(1);

    r.clock.advance(1);
    const fetched = r.net.next();
    const landed = r.nextLoad();
    const meanwhile = await r.pricing.table();
    expect(r.net.asked).toHaveLength(2);
    expect(perMillion(meanwhile, FETCHED_ONLY)).toBe(3);

    (await fetched).answer(ok(REMOTE_7));
    expect(await landed).toContain("outcome=ok");
    expect(perMillion(await r.pricing.table(), FETCHED_ONLY)).toBe(7);
    expect(r.net.asked).toHaveLength(2);
  });

  test("a second failure in a row doubles the wait", async () => {
    const r = rig();
    await firstLoad(r, failed("offline", "read"));
    r.clock.advance(MINUTE);
    const fetched = r.net.next();
    const second = r.nextLoad();
    await r.pricing.table();
    (await fetched).answer(failed("offline", "read"));
    expect(await second).toContain(`dueInMs=${2 * MINUTE}`);

    r.clock.advance(2 * MINUTE - 1);
    await r.pricing.table();
    expect(r.net.asked).toHaveLength(2);
    r.clock.advance(1);
    await r.pricing.table();
    expect(r.net.asked).toHaveLength(3);
  });
});

describe("a loaded table is refreshed once its day is up", () => {
  test("not before; the old table answers until the new one lands, which then prices every model, one priced before included", async () => {
    const r = rig();
    const { table: old } = await firstLoad(r, ok(REMOTE_7));
    expect(perMillion(old, FETCHED_ONLY)).toBe(7);

    // A wall clock stepped back cannot extend a running table’s lifetime.
    jest.spyOn(r.clock, "now").mockReturnValue(START.getTime() - DAY);
    r.clock.advance(DAY - 1);
    expect(await r.pricing.table()).toBe(old);
    expect(r.net.asked).toHaveLength(1);

    r.clock.advance(1);
    const fetched = r.net.next();
    const landed = r.nextLoad();
    // [LAW:single-enforcer] Askers past due share the one refresh.
    const asks = await Promise.all([
      r.pricing.table(),
      r.pricing.table(),
      r.pricing.table(),
    ]);
    for (const table of asks) expect(table).toBe(old);
    const call = await fetched;
    expect(await r.pricing.table()).toBe(old);
    expect(r.net.asked).toHaveLength(2);

    call.answer(ok(remote({ [FETCHED_ONLY]: rates(9) })));
    expect(await landed).toContain("by=period outcome=ok");
    expect(perMillion(await r.pricing.table(), FETCHED_ONLY)).toBe(9);
    expect(r.net.asked).toHaveLength(2);
  });

  test("a refresh that fails keeps the table that stood and tries again after the backoff", async () => {
    const r = rig();
    const { table: old } = await firstLoad(r, ok(REMOTE_7));
    r.clock.advance(DAY);
    const fetched = r.net.next();
    const failedLoad = r.nextLoad();
    await r.pricing.table();
    (await fetched).answer(failed("offline", "read"));

    const line = await failedLoad;
    expect(line).toContain(`prices=fetched dueInMs=${MINUTE}`);
    expect(await r.pricing.table()).toBe(old);
  });
});

describe("closing", () => {
  test("ends the load in flight: its fetch is aborted, its asker gets a table, and nothing of pricing's is left", async () => {
    const r = rig();
    const fetched = r.net.next();
    const ask = r.pricing.table();
    const call = await fetched;

    const closing = r.pricing.close();
    expect(call.signal.aborted).toBe(true);
    await closing;

    expect(perMillion(await ask, FETCHED_ONLY)).toBe(3);
    expect(r.record()).toMatchObject({ abandoned: 1, failures: 0 });
    // A closed owner starts no load: an ask is answered by the bundled rates,
    // with no read and no fetch.
    expect(perMillion(await r.pricing.table(), FETCHED_ONLY)).toBe(3);
    expect(r.reads()).toBe(1);
    expect(r.net.asked).toHaveLength(1);
    expect(r.clock.pending()).toBe(0);
  });

  test("a close while the cache file is being read starts no fetch", async () => {
    const r = rig();
    // The read starts in the ask's turn, so the close lands while it is out.
    const ask = r.pricing.table();
    await r.pricing.close();

    expect(perMillion(await ask, FETCHED_ONLY)).toBe(3);
    expect(r.reads()).toBe(1);
    expect(r.net.asked).toHaveLength(0);
  });

  test("a table that lands after the close began writes nothing and changes nothing", async () => {
    const r = rig({ endsOnAbort: false });
    const fetched = r.net.next();
    const ask = r.pricing.table();
    const call = await fetched;

    const closing = r.pricing.close();
    call.answer(ok(REMOTE_7));
    await closing;
    expect(perMillion(await ask, FETCHED_ONLY)).toBe(3);

    expect(fs.existsSync(r.cache)).toBe(false);
    expect(perMillion(await r.pricing.table(), FETCHED_ONLY)).toBe(3);
  });

  test("a close after the cache bytes are staged leaves the previous file untouched", async () => {
    const r = rig();
    writeCache(r.cache, { [FETCHED_ONLY]: rates(4) }, START.getTime() - DAY);
    const original = fs.readFileSync(r.cache, "utf8");
    let staged!: () => void;
    const bytesWritten = new Promise<void>((resolve) => (staged = resolve));
    let resume!: () => void;
    const publish = new Promise<void>((resolve) => (resume = resolve));
    const write = fs.promises.writeFile.bind(fs.promises);
    jest.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      staged();
      await publish;
    });

    const fetched = r.net.next();
    const asked = r.pricing.table();
    (await fetched).answer(ok(REMOTE_7));
    await bytesWritten;
    const closing = r.pricing.close();
    resume();
    await closing;
    await asked;

    expect(fs.readFileSync(r.cache, "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(r.cache))).toEqual([
      path.basename(r.cache),
    ]);
  });

  test("ends a refresh in flight, and the table that stood still answers", async () => {
    const r = rig();
    const { table: old } = await firstLoad(r, ok(REMOTE_7));
    r.clock.advance(DAY);
    const fetched = r.net.next();
    await r.pricing.table();
    const call = await fetched;

    await r.pricing.close();

    expect(call.signal.aborted).toBe(true);
    expect(await r.pricing.table()).toBe(old);
    expect(r.net.asked).toHaveLength(2);
    expect(r.clock.pending()).toBe(0);
  });
});
