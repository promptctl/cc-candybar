// The `today` fact (src/daemon/cache/session-usage-store.ts, TodayFacts) is
// everything a draw's `today` reads, so the draw's day is a pure function of
// the document's fact and the draw's instant. These tests state that
// contract: the sum, the rendering session counted once wherever its
// transcript lives, the day turning over with no owner moving, and the one
// order in which the fact fails.

import {
  dayKey,
  projectToday,
  type DaySums,
  type SessionDays,
  type TodayFacts,
} from "../src/daemon/cache/session-usage-store";
import { RefreshFaults } from "../src/daemon/refresh-faults";
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
    const today = projectToday({ ...SET, session: null }, NOON);
    expect(today).toMatchObject({
      kind: "ok",
      value: { cost: 4, tokens: 40, date: key(NOON) },
    });
  });

  test("the day turning over moves it with no owner moving", () => {
    const facts: TodayFacts = { ...SET, session: null };
    expect(projectToday(facts, NOON)).toMatchObject({ value: { cost: 4 } });
    expect(projectToday(facts, NEXT_DAY)).toMatchObject({ value: { cost: 1 } });
  });

  test("a day nothing was recorded on is absent", () => {
    const later = instantOf(new Date(2031, 0, 9, 12, 0, 0));
    expect(projectToday({ ...SET, session: null }, later)).toEqual(ABSENT);
  });

  test("a session outside the set's roots adds its own day", () => {
    const today = projectToday(
      {
        ...SET,
        session: {
          transcriptPath: "/elsewhere/own.jsonl",
          days: { [key(NOON)]: day(0.5, 5) },
        },
      },
      NOON,
    );
    expect(today).toMatchObject({ value: { cost: 4.5, tokens: 45 } });
  });

  test("a session under the roots is in the sums already, so counts once", () => {
    const today = projectToday(
      {
        ...SET,
        session: {
          transcriptPath: "/claude/projects/p/own.jsonl",
          days: { [key(NOON)]: day(0.5, 5) },
        },
      },
      NOON,
    );
    expect(today).toMatchObject({ value: { cost: 4, tokens: 40 } });
  });

  test("a session with no transcript path counts its own day", () => {
    const today = projectToday(
      {
        roots: SET.roots,
        sums: {},
        session: { transcriptPath: null, days: { [key(NOON)]: day(2, 20) } },
      },
      NOON,
    );
    expect(today).toMatchObject({ value: { cost: 2, tokens: 20 } });
  });
});

describe("todayReading", () => {
  const SID = "s1";
  const own = {
    transcriptPath: "/elsewhere/own.jsonl",
    days: { [key(NOON)]: day(0.5, 5) },
  };
  const usage = (days: Outcome<SessionDays>) => ({ daysOf: () => days });

  test("folds the set with the session's own days", () => {
    const fact = todayReading(
      settledLane(ok(SET)),
      new RefreshFaults(),
      usage(ok(own)),
      SID,
    );
    expect(fact).toEqual(ok({ ...SET, session: own }));
  });

  test("a session with no record has no days of its own", () => {
    const fact = todayReading(
      settledLane(ok(SET)),
      new RefreshFaults(),
      usage(ABSENT),
      SID,
    );
    expect(fact).toEqual(ok({ ...SET, session: null }));
  });

  test("the session's ingest failing is the fact failing", () => {
    const fault = failed("transcript unreadable", "read");
    const fact = todayReading(
      settledLane(ok(SET)),
      new RefreshFaults(),
      usage(fault),
      SID,
    );
    expect(fact).toEqual(fault);
  });

  test("the refresh's fault comes before the lane, and the lane before the session", () => {
    const faults = new RefreshFaults();
    faults.refreshed(SID, "today", "scan threw");
    expect(
      todayReading(settledLane(ok(SET)), faults, usage(ok(own)), SID),
    ).toEqual(failed("scan threw", "read"));

    const scan = failed("usage scan: broke", "read");
    expect(
      todayReading(
        settledLane(scan),
        new RefreshFaults(),
        usage(failed("transcript unreadable", "read")),
        SID,
      ),
    ).toEqual(scan);
  });
});

describe("todayOf", () => {
  const facts: TodayFacts = { ...SET, session: null };

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
