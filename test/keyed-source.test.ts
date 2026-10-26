import { KeyedSource } from "../src/utils/keyed-source";
import { Holds } from "../src/utils/holds";
import { failed, ok, type Outcome } from "../src/utils/outcome";
import { laneOutcome } from "../src/utils/reading";

// [LAW:behavior-not-structure] The contract of a keyed source, through its
// read, its changes and its supersede alone: a read takes the stored value
// and waits only on a key never read; a key is read again on its period only
// while a home holds it, or with no period when a hold returns to it; a change
// during a read queues one re-read; a supersede abandons the read in flight
// and holds back every trigger until it resumes, so no reader is answered with
// the reading from before it.

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
    const first = laneOutcome(source.declare(holds, "a"));
    const second = laneOutcome(source.declare(holds, "a"));
    expect(f.calls).toHaveLength(1);
    f.answer(0, ok("A"));
    expect(await first).toEqual(ok("A"));
    expect(await second).toEqual(ok("A"));
    expect(await laneOutcome(source.declare(holds, "a"))).toEqual(ok("A"));
    expect(f.calls).toHaveLength(1);
  });

  test("a held key is read again on its period, measured from the read that landed", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    await jest.advanceTimersByTimeAsync(400);
    f.answer(0, ok("A"));
    await first;
    await jest.advanceTimersByTimeAsync(EVERY.okMs - 1);
    expect(f.calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    // The stored value stands while the period's read is out.
    expect(await laneOutcome(source.declare(holds, "a"))).toEqual(ok("A"));
    f.answer(1, ok("B"));
    await settled();
    expect(await laneOutcome(source.declare(holds, "a"))).toEqual(ok("B"));
  });

  test("a failed read is retried on the failed period", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    f.answer(0, failed("down"));
    expect(await first).toEqual(failed("down"));
    await jest.advanceTimersByTimeAsync(EVERY.failedMs);
    expect(f.calls).toHaveLength(2);
  });

  test("a key nobody holds is not read on its period, and resumes at once when held again late", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    f.answer(0, ok("A"));
    await first;
    holds.declare(() => {});
    await jest.advanceTimersByTimeAsync(EVERY.okMs * 5);
    expect(f.calls).toHaveLength(1);
    // The next read takes the stored value and its hold back; the period,
    // long overdue, reads at once.
    expect(await laneOutcome(source.declare(holds, "a"))).toEqual(ok("A"));
    await settled();
    expect(f.calls).toHaveLength(2);
  });

  test("two homes holding one key: the period runs until the last releases it", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const a = new Holds();
    const b = new Holds();
    const first = laneOutcome(source.declare(a, "k"));
    void laneOutcome(source.declare(b, "k"));
    f.answer(0, ok("K"));
    await first;
    a.declare(() => {});
    await jest.advanceTimersByTimeAsync(EVERY.okMs);
    expect(f.calls).toHaveLength(2);
    f.answer(1, ok("K"));
    await settled();
    b.declare(() => {});
    await jest.advanceTimersByTimeAsync(EVERY.okMs * 3);
    expect(f.calls).toHaveLength(2);
    expect(source.stats().held).toBe(0);
  });

  test("a supersede abandons the read in flight: its waiter is answered by the read its resume starts", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const waiting = laneOutcome(source.declare(holds, "a"));
    const resume = source.supersede("a");
    expect(f.calls).toHaveLength(1);
    // The read from before the supersede lands first and is never stored.
    f.answer(0, ok("before"));
    await settled();
    resume();
    expect(f.calls).toHaveLength(2);
    f.answer(1, ok("after"));
    expect(await waiting).toEqual(ok("after"));
    expect(await laneOutcome(source.declare(holds, "a"))).toEqual(ok("after"));
  });

  // The abandoned read still ran: its event and its count say so, and a
  // failure it met is logged although nothing stores it.
  test("a read a supersede abandoned is still one event, marked not stored", async () => {
    const lines: Line[] = [];
    const f = fakeRead();
    source = sourceOf(f.read, { lines });
    const waiting = laneOutcome(source.declare(new Holds(), "a"));
    const resume = source.supersede("a");
    f.answer(0, failed("layer changed under it"));
    await settled();
    resume();
    f.answer(1, ok("after"));
    expect(await waiting).toEqual(ok("after"));
    expect(lines.map((l) => `${l.level} ${l.msg}`)).toEqual([
      expect.stringMatching(
        /^warn fake refresh key=a stored=N by=first outcome=failed reason="layer changed under it" took=\d+ms$/,
      ),
      expect.stringMatching(
        /^info fake refresh key=a stored=Y by=supersede outcome=ok took=\d+ms$/,
      ),
    ]);
    expect(source.stats()).toMatchObject({
      refreshes: { first: 1, period: 0, change: 0, supersede: 1 },
      failures: 1,
    });
  });

  test("a supersede of a stored value: pending, superseded, until the read its resume starts", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    f.answer(0, ok("before"));
    await first;
    const resume = source.supersede("a");
    expect(source.declare(holds, "a").current()).toMatchObject({
      kind: "pending",
      why: "superseded",
    });
    resume();
    const next = laneOutcome(source.declare(holds, "a"));
    f.answer(1, ok("after"));
    expect(await next).toEqual(ok("after"));
    expect(source.stats().refreshes).toEqual({
      first: 1,
      period: 0,
      change: 0,
      supersede: 1,
    });
  });

  test("a key's first read is pending as unread", () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    expect(source.declare(new Holds(), "a").current()).toMatchObject({
      kind: "pending",
      why: "unread",
    });
  });

  test("a supersede holds back every trigger of its key until it resumes", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    f.answer(0, ok("A"));
    await first;
    const resume = source.supersede("a");
    // Its period comes due, and the world changes: neither reads.
    await jest.advanceTimersByTimeAsync(EVERY.okMs * 3);
    source.changed(() => true);
    expect(f.calls).toHaveLength(1);
    resume();
    expect(f.calls).toHaveLength(2);
    f.answer(1, ok("B"));
    await settled();
    expect(source.declare(holds, "a").current()).toEqual(ok("B"));
  });

  test("two overlapping supersedes need both resumes, and the last starts one read", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    f.answer(0, ok("A"));
    await first;
    const one = source.supersede("a");
    const two = source.supersede("a");
    one();
    one();
    expect(f.calls).toHaveLength(1);
    expect(source.declare(holds, "a").current()).toMatchObject({
      kind: "pending",
      why: "superseded",
    });
    two();
    expect(f.calls).toHaveLength(2);
  });

  test("a period tick while a supersede's read is out shares it", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    f.answer(0, ok("A"));
    await first;
    await jest.advanceTimersByTimeAsync(EVERY.okMs - 1);
    source.supersede("a")();
    await jest.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
  });

  test("a key never read: a supersede holds its first read until it resumes", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const resume = source.supersede("a");
    const waiting = laneOutcome(source.declare(new Holds(), "a"));
    expect(f.calls).toHaveLength(0);
    resume();
    expect(f.calls).toHaveLength(1);
    f.answer(0, ok("A"));
    expect(await waiting).toEqual(ok("A"));
  });

  test("a change while a read is out queues exactly one re-read, which lands last", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    source.changed(() => true);
    source.changed(() => true);
    source.changed(() => true);
    expect(f.calls).toHaveLength(1);
    f.answer(0, ok("old"));
    expect(await first).toEqual(ok("old"));
    expect(f.calls).toHaveLength(2);
    // The value stands while the re-read is out.
    expect(source.declare(holds, "a").current()).toEqual(ok("old"));
    f.answer(1, ok("new"));
    await settled();
    expect(f.calls).toHaveLength(2);
    expect(source.declare(holds, "a").current()).toEqual(ok("new"));
    expect(source.stats().refreshes).toMatchObject({ first: 1, change: 1 });
  });

  test("a change reads only the held entries it names", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const loose = new Holds();
    void laneOutcome(source.declare(holds, "a"));
    void laneOutcome(source.declare(holds, "b"));
    void laneOutcome(source.declare(loose, "c"));
    loose.declare(() => {});
    f.answer(0, ok("A"));
    f.answer(1, ok("B"));
    f.answer(2, ok("C"));
    await settled();
    source.changed((k) => k !== "b");
    expect(f.calls.map((c) => c.key)).toEqual(["a", "b", "c", "a"]);
  });

  describe("with no period", () => {
    const noPeriod = (read: (key: string) => Promise<Outcome<string>>) =>
      new KeyedSource<string, string>({
        name: "fake",
        keyOf: (k) => k,
        fields: (k) => `key=${k}`,
        read,
        every: null,
        maxEntries: 64,
        logger: () => {},
      });

    test("a held entry is read only on a change, never on a clock", async () => {
      const f = fakeRead();
      const s = noPeriod(f.read);
      source = s;
      const first = laneOutcome(s.declare(new Holds(), "a"));
      f.answer(0, ok("A"));
      await first;
      await jest.advanceTimersByTimeAsync(EVERY.okMs * 100);
      expect(f.calls).toHaveLength(1);
    });

    test("hold, release, change, hold again: the hold's return re-reads, drawing the kept value meanwhile", async () => {
      const f = fakeRead();
      const s = noPeriod(f.read);
      source = s;
      const holds = new Holds();
      const first = laneOutcome(s.declare(holds, "a"));
      f.answer(0, ok("before"));
      await first;
      holds.declare(() => {});
      // Written while nobody held it: the change reads nothing.
      s.changed(() => true);
      expect(f.calls).toHaveLength(1);
      const lane = s.declare(holds, "a");
      expect(f.calls).toHaveLength(2);
      expect(lane.current()).toEqual(ok("before"));
      f.answer(1, ok("written"));
      await settled();
      expect(lane.current()).toEqual(ok("written"));
      expect(s.stats().refreshes).toMatchObject({ first: 1, change: 1 });
    });

    test("a second holder of a held entry reads nothing", async () => {
      const f = fakeRead();
      const s = noPeriod(f.read);
      source = s;
      const first = laneOutcome(s.declare(new Holds(), "a"));
      f.answer(0, ok("A"));
      await first;
      s.declare(new Holds(), "a");
      expect(f.calls).toHaveLength(1);
    });
  });

  test("the LRU evicts only keys nobody holds", async () => {
    const f = fakeRead();
    source = sourceOf(f.read, { maxEntries: 1 });
    const held = new Holds();
    const loose = new Holds();
    void laneOutcome(source.declare(held, "kept"));
    void laneOutcome(source.declare(loose, "a"));
    loose.declare(() => {});
    void laneOutcome(source.declare(loose, "b"));
    // "kept" is held, so the bound falls on "a": two entries, one held.
    expect(source.stats()).toMatchObject({ entries: 2, held: 2 });
    loose.declare(() => {});
    void laneOutcome(source.declare(new Holds(), "c"));
    expect(source.stats().entries).toBe(2);
    // "kept" is still the stored entry: read again, it asks nothing.
    const reads = f.calls.length;
    void laneOutcome(source.declare(held, "kept"));
    expect(f.calls).toHaveLength(reads);
  });

  test("supersedes of keys nobody holds stay within the bound once they resume, and none is dropped mid-move", () => {
    const f = fakeRead();
    source = sourceOf(f.read, { maxEntries: 1 });
    const moving = source.supersede("a");
    // "a" is mid-move, so it is kept past the bound.
    const resumes = ["b", "c"].map((k) => source!.supersede(k));
    expect(source.stats().entries).toBe(3);
    moving();
    for (const resume of resumes) resume();
    source.supersede("d")();
    expect(source.stats().entries).toBe(1);
  });

  test("a waiter on a key the LRU drops is answered, never left waiting", async () => {
    const f = fakeRead();
    source = sourceOf(f.read, { maxEntries: 0 });
    const holds = new Holds();
    const waiting = laneOutcome(source.declare(holds, "a"));
    holds.declare(() => {});
    void laneOutcome(source.declare(new Holds(), "b"));
    expect(await waiting).toEqual(failed("fake entry dropped"));
  });

  test("each refresh is logged once, a failed one at warn; reads of it log nothing", async () => {
    const lines: Line[] = [];
    const f = fakeRead();
    source = sourceOf(f.read, { lines });
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    f.answer(0, failed("no server"));
    await first;
    await laneOutcome(source.declare(holds, "a"));
    await laneOutcome(source.declare(holds, "a"));
    expect(lines).toEqual([
      {
        level: "warn",
        msg: expect.stringMatching(
          /^fake refresh key=a stored=Y by=first outcome=failed reason="no server" took=\d+ms$/,
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
    const out = await laneOutcome(source.declare(holds, "a"));
    expect(out).toEqual(failed("read threw: Error: boom"));
    await jest.advanceTimersByTimeAsync(EVERY.failedMs);
    expect(calls).toBe(2);
    expect(lines[0]).toMatchObject({ level: "warn" });
  });

  test("a declaration into a closed home throws, for the view's declaration to report", () => {
    const f = fakeRead();
    const closing = sourceOf(f.read);
    source = closing;
    const holds = new Holds();
    holds.close();
    expect(() => closing.declare(holds, "a")).toThrow(
      "hold taken after close: fake:a",
    );
  });

  test("close ends every period", async () => {
    const f = fakeRead();
    source = sourceOf(f.read);
    const holds = new Holds();
    const first = laneOutcome(source.declare(holds, "a"));
    f.answer(0, ok("A"));
    await first;
    source.close();
    await jest.advanceTimersByTimeAsync(EVERY.okMs * 5);
    expect(f.calls).toHaveLength(1);
  });
});
