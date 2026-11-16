// The `today` fact (src/daemon/foundations/today-facts.ts, TodayFacts) is
// everything a draw's `today` reads, so the draw's day is a pure function of
// the document's fact and the draw's instant. These tests state that
// contract: the sum, the rendering session's days beside the set's, the day
// turning over with no owner moving, and the one order in which the fact
// fails, a session under the set's roots counted once, by the set.

import type { DaySums } from "../src/daemon/cache/session-usage-store";
import { dayKey, projectToday } from "../src/daemon/foundations/today-facts";
import { type DayUsage, type TodayFacts } from "../src/facts/world-state";
import { todayOf } from "../src/renderer/render-payload";
import { todayReading } from "../src/daemon/readings";
import { dateOf, instantOf } from "../src/utils/instant";
import {
  ABSENT,
  failed,
  ok,
  pendingOf,
  type Outcome,
} from "../src/utils/outcome";
import { pending, settledLane } from "../src/utils/reading";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

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
  const SID = sessionIdOf("s1");
  const OUTSIDE = "/elsewhere/s1.jsonl";
  const UNDER = "/claude/projects/p/s1.jsonl";
  const ENTRY = ok(null);
  const own = { [key(NOON)]: day(0.5, 5) };
  // A usage store that answers `days`, and says which sessions it was asked
  // about.
  const usage = (days: Outcome<Readonly<Record<string, DayUsage>>>) => {
    const asked: string[] = [];
    return {
      asked,
      daysOf: (session: string) => {
        asked.push(session);
        return days;
      },
    };
  };

  test("folds the set with the days of a session outside its roots", () => {
    const store = usage(ok(own));
    const fact = todayReading(settledLane(ok(SET)), store, SID, OUTSIDE, ENTRY);
    expect(fact).toEqual(ok({ sums: SET.sums, own }));
    expect(store.asked).toEqual([SID]);
  });

  test("a session with no record outside the set has no days of its own", () => {
    const fact = todayReading(
      settledLane(ok(SET)),
      usage(ABSENT),
      SID,
      OUTSIDE,
      ENTRY,
    );
    expect(fact).toEqual(ok({ sums: SET.sums, own: {} }));
  });

  test("a session under the set's roots is the set's: its record and its entry are not asked", () => {
    const store = usage(failed("transcript unreadable", "read"));
    const fact = todayReading(
      settledLane(ok(SET)),
      store,
      SID,
      UNDER,
      failed("declaration threw", "read"),
    );
    expect(fact).toEqual(ok({ sums: SET.sums, own: {} }));
    expect(store.asked).toEqual([]);
  });

  test("outside the roots, the transcript entry failing is the fact failing, record or none", () => {
    const entry = failed("usage store closed", "read");
    expect(
      todayReading(settledLane(ok(SET)), usage(ABSENT), SID, OUTSIDE, entry),
    ).toEqual(entry);
  });

  test("outside the roots, an entry not answered yet is a fact not answered yet", () => {
    const entry = pending("unread");
    expect(
      todayReading(settledLane(ok(SET)), usage(ABSENT), SID, OUTSIDE, entry),
    ).toEqual(entry);
  });

  test("the session's ingest failing outside the roots is the fact failing", () => {
    const fault = failed("transcript unreadable", "read");
    expect(
      todayReading(settledLane(ok(SET)), usage(fault), SID, OUTSIDE, ENTRY),
    ).toEqual(fault);
  });

  test("the lane's own failure comes before the session's", () => {
    const scan = failed("usage scan: broke", "read");
    expect(
      todayReading(
        settledLane(scan),
        usage(failed("transcript unreadable", "read")),
        SID,
        OUTSIDE,
        failed("declaration threw", "read"),
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
