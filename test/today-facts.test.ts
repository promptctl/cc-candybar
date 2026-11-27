// The `today` fact (src/daemon/foundations/today-facts.ts, TodayFacts) is
// everything a draw's `today` reads, so the draw's day is a pure function of
// the document's fact and the draw's instant. These tests state that
// contract: the sum, the rendering session's days beside the set's, the day
// turning over with no owner moving, and the one order in which the fact
// fails. That a session under the set's roots is not counted twice is the
// store's read (test/daemon-session-usage-store.test.ts).

import { SAMPLE_CALENDAR } from "../scripts/lib/draw-fixtures/sample-region.js";
import type { DaySums } from "../src/daemon/cache/session-usage-store";
import { ZonedCalendar } from "../src/utils/calendar";
import { projectToday } from "../src/daemon/foundations/today-facts";
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
import { settledLane } from "../src/utils/reading";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const NOON = instantOf(new Date("2031-01-02T12:00:00Z"));
const NEXT_DAY = instantOf(new Date("2031-01-03T12:00:00Z"));
const key = (at: typeof NOON) => SAMPLE_CALENDAR.dayKey(dateOf(at));

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

test("the recorded calendar selects the host bucket at midnight and spans both lengths of DST day", () => {
  const calendar = new ZonedCalendar("America/New_York");
  const instant = (iso: string) => instantOf(new Date(iso));
  const facts = { sums: {
    "2024-03-09": day(9, 90), "2024-03-10": day(10, 100),
  }, own: {} };
  expect(todayOf(ok(facts), instant("2024-03-10T04:59:59Z"), calendar)).toEqual({ cost: 9, tokens: 90 });
  expect(todayOf(ok(facts), instant("2024-03-10T05:00:00Z"), calendar)).toEqual({ cost: 10, tokens: 100 });
  expect(calendar.previousMidnight(Date.parse("2024-03-11T04:00:00Z"))).toBe(Date.parse("2024-03-10T05:00:00Z"));
  expect(calendar.previousMidnight(Date.parse("2024-11-04T05:00:00Z"))).toBe(Date.parse("2024-11-03T04:00:00Z"));
});

test.each([
  ["Pacific/Kiritimati", "+275760-09-13T00:00:00.000Z", "275760-09-13", 840],
  ["America/New_York", "-271821-04-20T00:00:00.000Z", "-271821-04-19", -296],
  ["Europe/Kiev", "2026-11-30T22:30:00Z", "2026-12-01", 120],
  ["Europe/Kyiv", "2026-11-30T22:30:00Z", "2026-12-01", 120],
  ["US/Eastern", "2110-07-15T03:59:59Z", "2110-07-14", -240],
  ["America/New_York", "2110-07-15T03:59:59Z", "2110-07-14", -240],
  ["Africa/Casablanca", "2026-11-30T23:30:00Z", "2026-11-30", 0],
] as const)("uses the shipped transition rules for %s at %s", (zone, iso, dayKey, offsetMinutes) => {
  const calendar = new ZonedCalendar(zone);
  const date = new Date(iso);
  expect(calendar.dayKey(date)).toBe(dayKey);
  expect(calendar.partsAt(date).offsetMinutes).toBe(offsetMinutes);
});

describe("projectToday", () => {
  test("sums the day of the draw's instant out of the set", () => {
    const today = projectToday({ sums: SET.sums, own: {} }, NOON, SAMPLE_CALENDAR);
    expect(today).toMatchObject({
      kind: "ok",
      value: { cost: 4, tokens: 40, date: key(NOON) },
    });
  });

  test("the day turning over moves it with no owner moving", () => {
    const facts: TodayFacts = { sums: SET.sums, own: {} };
    expect(projectToday(facts, NOON, SAMPLE_CALENDAR)).toMatchObject({ value: { cost: 4 } });
    expect(projectToday(facts, NEXT_DAY, SAMPLE_CALENDAR)).toMatchObject({ value: { cost: 1 } });
  });

  test("a day nothing was recorded on is absent", () => {
    const later = instantOf(new Date(2031, 0, 9, 12, 0, 0));
    expect(projectToday({ sums: SET.sums, own: {} }, later, SAMPLE_CALENDAR)).toEqual(ABSENT);
  });

  test("the session's own day adds to the set's", () => {
    const today = projectToday(
      { sums: SET.sums, own: { [key(NOON)]: day(0.5, 5) } },
      NOON, SAMPLE_CALENDAR,
    );
    expect(today).toMatchObject({ value: { cost: 4.5, tokens: 45 } });
  });

  test("the session's own day counts when the set holds none", () => {
    const today = projectToday(
      { sums: {}, own: { [key(NOON)]: day(2, 20) } },
      NOON, SAMPLE_CALENDAR,
    );
    expect(today).toMatchObject({ value: { cost: 2, tokens: 20 } });
  });
});

describe("todayReading", () => {
  const SID = sessionIdOf("s1");
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
    const fact = todayReading(settledLane(ok(SET)), store, SID);
    expect(fact).toEqual(ok({ sums: SET.sums, own }));
    expect(store.asked).toEqual([SET.roots]);
  });

  test("a session with no days outside the set has none of its own", () => {
    const fact = todayReading(settledLane(ok(SET)), usage(ABSENT), SID);
    expect(fact).toEqual(ok({ sums: SET.sums, own: {} }));
  });

  test("the session's ingest failing is the fact failing", () => {
    const fault = failed("transcript unreadable", "read");
    const fact = todayReading(settledLane(ok(SET)), usage(fault), SID);
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
    expect(todayOf(ok(facts), NOON, SAMPLE_CALENDAR)).toEqual({ cost: 4, tokens: 40 });
  });

  test("a fact not answered yet is not answered yet, in the reason it gave", () => {
    expect(todayOf(pendingOf("superseded"), NOON, SAMPLE_CALENDAR)).toEqual(
      pendingOf("superseded"),
    );
  });

  test("a failed or absent fact draws nothing", () => {
    expect(todayOf(failed("scan broke", "read"), NOON, SAMPLE_CALENDAR)).toBeUndefined();
    expect(todayOf(ABSENT, NOON, SAMPLE_CALENDAR)).toBeUndefined();
  });
});
