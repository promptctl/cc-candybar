// [LAW:behavior-not-structure] The update act's budget is spent in observed
// time (brandon-unfiled-3248.9eu3): each look at the act alive counts the span
// since the look before it when the loop could have run that span, so a machine
// asleep mid-act spends none of it, and a wall clock set back spends nothing.

import {
  latestLook,
  observe,
  unwatched,
  type ActRecord,
} from "../../src/daemon/update-act";

const STARTED = 1_800_000_000_000;
const RECORD: ActRecord = {
  identity: "id-1",
  pid: 1,
  startTime: "t",
  started: STARTED,
  deadline: STARTED + 600_000,
};
const HOUR = 60 * 60 * 1000;
const LONGEST = 10_000;

describe("observe: one look at an act alive", () => {
  test("an act no daemon has looked at counts from its start: a first look 2 s in has spent 2 s", () => {
    expect(observe(unwatched(RECORD), STARTED + 2_000, LONGEST)).toEqual({
      spentMs: 2_000,
      lastSeen: STARTED + 2_000,
    });
  });

  test("consecutive looks 2 s apart add 2 s each", () => {
    let awake = unwatched(RECORD);
    for (let i = 1; i <= 5; i++)
      awake = observe(awake, STARTED + i * 2_000, LONGEST);
    expect(awake).toEqual({ spentMs: 10_000, lastSeen: STARTED + 10_000 });
  });

  test("a sleep of an hour between two looks adds nothing, and a span the loop could run adds in full", () => {
    const before = { spentMs: 30_000, lastSeen: STARTED + 30_000 };
    expect(observe(before, before.lastSeen + HOUR, LONGEST)).toEqual({
      spentMs: 30_000,
      lastSeen: before.lastSeen + HOUR,
    });
    expect(observe(before, before.lastSeen + LONGEST, LONGEST).spentMs).toBe(
      30_000 + LONGEST,
    );
  });

  test("a wall clock set backwards adds nothing, and the next look counts from where it reads now", () => {
    const before = { spentMs: 30_000, lastSeen: STARTED + 30_000 };
    const back = observe(before, before.lastSeen - HOUR, LONGEST);
    expect(back).toEqual({ spentMs: 30_000, lastSeen: before.lastSeen - HOUR });
    expect(observe(back, back.lastSeen + 2_000, LONGEST).spentMs).toBe(32_000);
  });

  test("two daemons racing one look lose nothing, whichever write lands last", () => {
    const before = { spentMs: 30_000, lastSeen: STARTED + 30_000 };
    const a = observe(before, before.lastSeen + 1_000, LONGEST);
    const b = observe(before, before.lastSeen + 1_500, LONGEST);
    const next = before.lastSeen + 3_000;
    for (const landed of [a, b]) {
      expect(observe(landed, next, LONGEST).spentMs).toBe(33_000);
    }
  });
});

describe("latestLook: the look a daemon counts on from", () => {
  const shared = { spentMs: 30_000, lastSeen: STARTED + 30_000 };

  test("this daemon's own look wins when it is later than the act's files: a write that failed loses no spend", () => {
    const own = { spentMs: 34_000, lastSeen: STARTED + 34_000 };
    expect(latestLook(RECORD, shared, own)).toEqual(own);
  });

  test("the act's files win when they are later: another daemon looked after this one", () => {
    const own = { spentMs: 28_000, lastSeen: STARTED + 28_000 };
    expect(latestLook(RECORD, shared, own)).toEqual(shared);
  });

  test("with no look of its own, a daemon counts on from the act's files, or from the act's start when they hold none", () => {
    expect(latestLook(RECORD, shared, null)).toEqual(shared);
    expect(latestLook(RECORD, null, null)).toEqual(unwatched(RECORD));
  });

  test("with nothing in the act's files, a daemon counts on from its own look", () => {
    const own = { spentMs: 4_000, lastSeen: STARTED + 4_000 };
    expect(latestLook(RECORD, null, own)).toEqual(own);
  });
});
