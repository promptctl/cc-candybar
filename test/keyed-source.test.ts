import { KeyedSource } from "../src/utils/keyed-source";
import { Holds } from "../src/utils/holds";
import { failed, ok, type Outcome } from "../src/utils/outcome";

// [LAW:behavior-not-structure] The contract of a keyed source, through its
// read and its supersede alone (brandon-unfiled-3248.8ro6, step 1): a read
// takes the stored value and waits only on a key never read; a key is read
// again on its period only while a home holds it; a supersede abandons the
// read in flight, so no reader is answered with the reading from before it.

type Line = { level: string; msg: string };

// A read the test answers by hand: each call is queued until `answer`.
function fakeRead() {
  const calls: Array<{
    key: string;
    resolve: (o: Outcome<string>) => void;
  }> = [];
  return {
    calls,
    read: (key: string): Promise<Outcome<string>> =>
      new Promise((resolve) => calls.push({ key, resolve })),
    answer(i: number, outcome: Outcome<string>): void {
      calls[i]!.resolve(outcome);
    },
  };
}

const EVERY = { okMs: 1_000, failedMs: 100 };

function sourceOf(
  read: (key: string) => Promise<Outcome<string>>,
  opts: { maxEntries?: number; lines?: Line[] } = {},
) {
  return new KeyedSource<string, string>({
    name: "fake",
    keyOf: (k) => k,
    fields: (k) => `key=${k}`,
    read,
    every: EVERY,
    maxEntries: opts.maxEntries ?? 64,
    logger: (level, msg) => opts.lines?.push({ level, msg }),
  });
}

const settled = (): Promise<void> => jest.advanceTimersByTimeAsync(0);

let source: KeyedSource<string, string> | undefined;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  source?.close();
  source = undefined;
  jest.useRealTimers();
});

describe("KeyedSource", () => {
  test("a first read waits on the read; every later one takes the stored value", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = source.read(holds, "a");
    const second = source.read(holds, "a");
    expect(f.calls).toHaveLength(1);
    f.answer(0, ok("A"));
    expect(await first).toEqual(ok("A"));
    expect(await second).toEqual(ok("A"));
    expect(await source.read(holds, "a")).toEqual(ok("A"));
    expect(f.calls).toHaveLength(1);
  });

  test("a held key is read again on its period, measured from the read that landed", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = source.read(holds, "a");
    await jest.advanceTimersByTimeAsync(400);
    f.answer(0, ok("A"));
    await first;
    await jest.advanceTimersByTimeAsync(EVERY.okMs - 1);
    expect(f.calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    // The stored value stands while the period's read is out.
    expect(await source.read(holds, "a")).toEqual(ok("A"));
    f.answer(1, ok("B"));
    await settled();
    expect(await source.read(holds, "a")).toEqual(ok("B"));
  });

  test("a failed read is retried on the failed period", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = source.read(holds, "a");
    f.answer(0, failed("down"));
    expect(await first).toEqual(failed("down"));
    await jest.advanceTimersByTimeAsync(EVERY.failedMs);
    expect(f.calls).toHaveLength(2);
  });

  test("a key nobody holds is not read on its period, and resumes at once when held again late", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = source.read(holds, "a");
    f.answer(0, ok("A"));
    await first;
    holds.release();
    await jest.advanceTimersByTimeAsync(EVERY.okMs * 5);
    expect(f.calls).toHaveLength(1);
    // The next read takes the stored value and its hold back; the period,
    // long overdue, reads at once.
    expect(await source.read(holds, "a")).toEqual(ok("A"));
    await settled();
    expect(f.calls).toHaveLength(2);
  });

  test("two homes holding one key: the period runs until the last releases it", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const a = new Holds();
    const b = new Holds();
    const first = source.read(a, "k");
    void source.read(b, "k");
    f.answer(0, ok("K"));
    await first;
    a.release();
    await jest.advanceTimersByTimeAsync(EVERY.okMs);
    expect(f.calls).toHaveLength(2);
    f.answer(1, ok("K"));
    await settled();
    b.release();
    await jest.advanceTimersByTimeAsync(EVERY.okMs * 3);
    expect(f.calls).toHaveLength(2);
    expect(source.stats().held).toBe(0);
  });

  test("a supersede abandons the read in flight: its waiter is answered by the fresh read", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const waiting = source.read(holds, "a");
    source.supersede("a");
    expect(f.calls).toHaveLength(2);
    // The read from before the supersede lands first and is never stored.
    f.answer(0, ok("before"));
    await settled();
    f.answer(1, ok("after"));
    expect(await waiting).toEqual(ok("after"));
    expect(await source.read(holds, "a")).toEqual(ok("after"));
  });

  test("a supersede of a stored value: the next read waits on the fresh read, never the old value", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = source.read(holds, "a");
    f.answer(0, ok("before"));
    await first;
    source.supersede("a");
    const next = source.read(holds, "a");
    f.answer(1, ok("after"));
    expect(await next).toEqual(ok("after"));
    expect(source.stats().refreshes).toEqual({
      first: 1,
      period: 0,
      supersede: 1,
    });
  });

  test("a period tick while a supersede's read is out shares it", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = source.read(holds, "a");
    f.answer(0, ok("A"));
    await first;
    await jest.advanceTimersByTimeAsync(EVERY.okMs - 1);
    source.supersede("a");
    await jest.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
  });

  test("a key never read has nothing to supersede", () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    source.supersede("a");
    expect(f.calls).toHaveLength(0);
  });

  test("the LRU evicts only keys nobody holds", async () => {
    const f = fakeRead();
    source = sourceOf(f.read, { maxEntries: 1 });
    const held = new Holds();
    const loose = new Holds();
    void source.read(held, "kept");
    void source.read(loose, "a");
    loose.release();
    void source.read(loose, "b");
    // "kept" is held, so the bound falls on "a": two entries, one held.
    expect(source.stats()).toMatchObject({ entries: 2, held: 2 });
    loose.release();
    void source.read(new Holds(), "c");
    expect(source.stats().entries).toBe(2);
    // "kept" is still the stored entry: read again, it asks nothing.
    const reads = f.calls.length;
    void source.read(held, "kept");
    expect(f.calls).toHaveLength(reads);
  });

  test("a waiter on a key the LRU drops is answered, never left waiting", async () => {
    const f = fakeRead();
    source = sourceOf(f.read, { maxEntries: 0 });
    const holds = new Holds();
    const waiting = source.read(holds, "a");
    holds.release();
    void source.read(new Holds(), "b");
    expect(await waiting).toEqual(failed("fake entry dropped"));
  });

  test("each refresh is logged once, a failed one at warn; reads of it log nothing", async () => {
    const lines: Line[] = [];
    const f = fakeRead();
    source = sourceOf(f.read, { lines });
    const holds = new Holds();
    const first = source.read(holds, "a");
    f.answer(0, failed("no server"));
    await first;
    await source.read(holds, "a");
    await source.read(holds, "a");
    expect(lines).toEqual([
      {
        level: "warn",
        msg: expect.stringMatching(
          /^fake refresh key=a by=first outcome=failed reason="no server" took=\d+ms$/,
        ),
      },
    ]);
    expect(source.stats().failures).toBe(1);
  });

  test("a read that throws is the refresh's failure, and the key is still visited on its period", async () => {
    const lines: Line[] = [];
    let calls = 0;
    source = sourceOf(
      () => {
        calls++;
        throw new Error("boom");
      },
      { lines },
    );
    const holds = new Holds();
    const out = await source.read(holds, "a");
    expect(out).toEqual(failed("read threw: Error: boom"));
    await jest.advanceTimersByTimeAsync(EVERY.failedMs);
    expect(calls).toBe(2);
    expect(lines[0]).toMatchObject({ level: "warn" });
  });

  test("a read on a closed home never rejects: it is logged where it surfaces", async () => {
    const lines: Line[] = [];
    const f = fakeRead();
    source = sourceOf(f.read, { lines });
    const holds = new Holds();
    holds.close();
    const out = await source.read(holds, "a");
    expect(out.kind).toBe("failed");
    expect(lines).toEqual([
      {
        level: "error",
        msg: "fake read threw: Error: hold taken after close: fake:a",
      },
    ]);
  });

  test("close ends every period", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = source.read(holds, "a");
    f.answer(0, ok("A"));
    await first;
    source.close();
    await jest.advanceTimersByTimeAsync(EVERY.okMs * 5);
    expect(f.calls).toHaveLength(1);
  });
});
