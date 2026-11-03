// The `today` fact (src/daemon/cache/today-facts.ts, TodayFacts) is
// everything a draw's `today` reads, so the draw's day is a pure function of
// the document's fact and the draw's instant. These tests state that
// contract: the sum, the rendering session's days beside the set's, the day
// turning over with no owner moving, and the one order in which the fact
// fails. That a session under the set's roots is not counted twice is the
// store's read (test/daemon-session-usage-store.test.ts).

import type { DaySums } from "../src/daemon/cache/session-usage-store";
import {
  dayKey,
  projectToday,
  type DayUsage,
  type TodayFacts,
} from "../src/daemon/cache/today-facts";
import { todayOf, todayReading } from "../src/daemon/render-payload";
import { dateOf, instantOf } from "../src/utils/instant";
import {
  ABSENT,
  failed,
  ok,
  pendingOf,
  type Outcome,
} from "../src/utils/outcome";
import { settledLane } from "../src/utils/reading";

const NOON = instantOf(new Date(2031, 0, 2, 12, 0, 0));
const NEXT_DAY = instantOf(new Date(2031, 0, 3, 12, 0, 0));
const key = (at: typeof NOON) => dayKey(dateOf(at));

const day = (cost: number, input: number) => ({
  cost,
  input,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
});

const SET: DaySums = {
  roots: ["/claude/projects"],
  sums: { [key(NOON)]: day(4, 40), [key(NEXT_DAY)]: day(1, 10) },
};

describe("projectToday", () => {
  test("sums the day of the draw's instant out of the set", () => {
    const today = projectToday({ sums: SET.sums, own: {} }, NOON);
    expect(today).toMatchObject({
      kind: "ok",
      value: { cost: 4, tokens: 40, date: key(NOON) },
    });
  });

  test("the day turning over moves it with no owner moving", () => {
    const facts: TodayFacts = { sums: SET.sums, own: {} };
    expect(projectToday(facts, NOON)).toMatchObject({ value: { cost: 4 } });
    expect(projectToday(facts, NEXT_DAY)).toMatchObject({ value: { cost: 1 } });
  });

  test("a day nothing was recorded on is absent", () => {
    const later = instantOf(new Date(2031, 0, 9, 12, 0, 0));
    expect(projectToday({ sums: SET.sums, own: {} }, later)).toEqual(ABSENT);
  });

  test("the session's own day adds to the set's", () => {
    const today = projectToday(
      { sums: SET.sums, own: { [key(NOON)]: day(0.5, 5) } },
      NOON,
    );
    expect(today).toMatchObject({ value: { cost: 4.5, tokens: 45 } });
  });

  test("the session's own day counts when the set holds none", () => {
    const today = projectToday(
      { sums: {}, own: { [key(NOON)]: day(2, 20) } },
      NOON,
    );
    expect(today).toMatchObject({ value: { cost: 2, tokens: 20 } });
  });
});

describe("todayReading", () => {
  const SID = "s1";
  const own = { [key(NOON)]: day(0.5, 5) };
  // A usage store that answers `days`, and says which roots it was asked about.
  const usage = (days: Outcome<Readonly<Record<string, DayUsage>>>) => {
    const asked: Array<readonly string[]> = [];
    return {
      asked,
      daysOutside: (_session: string, roots: readonly string[]) => {
        asked.push(roots);
        return days;
      },
    };
  };

  test("folds the set with the session's days outside its roots", () => {
    const store = usage(ok(own));
    const fact = todayReading(
      settledLane(ok(SET)),
      store,
      SID,
    );
    expect(fact).toEqual(ok({ sums: SET.sums, own }));
    expect(store.asked).toEqual([SET.roots]);
  });

  test("a session with no days outside the set has none of its own", () => {
    const fact = todayReading(
      settledLane(ok(SET)),
      usage(ABSENT),
      SID,
    );
    expect(fact).toEqual(ok({ sums: SET.sums, own: {} }));
  });

  test("the session's ingest failing is the fact failing", () => {
    const fault = failed("transcript unreadable", "read");
    const fact = todayReading(
      settledLane(ok(SET)),
      usage(fault),
      SID,
    );
    expect(fact).toEqual(fault);
  });

  test("the lane's own failure comes before the session's", () => {
    const scan = failed("usage scan: broke", "read");
    expect(
      todayReading(
        settledLane(scan),
        usage(failed("transcript unreadable", "read")),
        SID,
      ),
    ).toEqual(scan);
  });
});

describe("todayOf", () => {
  const facts: TodayFacts = { sums: SET.sums, own: {} };

  test("an ok fact is the day's cost and tokens", () => {
    expect(todayOf(ok(facts), NOON)).toEqual({ cost: 4, tokens: 40 });
  });

  test("a fact not answered yet is not answered yet, in the reason it gave", () => {
    expect(todayOf(pendingOf("superseded"), NOON)).toEqual(
      pendingOf("superseded"),
    );
  });

  test("a failed or absent fact draws nothing", () => {
    expect(todayOf(failed("scan broke", "read"), NOON)).toBeUndefined();
    expect(todayOf(ABSENT, NOON)).toBeUndefined();
  });
});
