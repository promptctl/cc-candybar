// [LAW:behavior-not-structure] The update act's budget is spent in observed
// time (brandon-unfiled-3248.9eu3): each look at the act alive counts the span
// since the look before it, up to a cap, so a machine asleep mid-act spends
// almost none of it, and a wall clock set back spends nothing.

import {
  observe,
  STEP_CAP_MS,
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

describe("observe: one look at an act alive", () => {
  test("an act no daemon has looked at has spent nothing, as of its start", () => {
    expect(observe(unwatched(RECORD), STARTED + 2_000)).toEqual({
      spentMs: 2_000,
      lastSeen: STARTED + 2_000,
    });
  });

  test("consecutive looks 2 s apart add 2 s each", () => {
    let awake = unwatched(RECORD);
    for (let i = 1; i <= 5; i++) awake = observe(awake, STARTED + i * 2_000);
    expect(awake).toEqual({ spentMs: 10_000, lastSeen: STARTED + 10_000 });
  });

  test("a sleep of an hour between two looks adds the cap, not the hour", () => {
    const before = { spentMs: 30_000, lastSeen: STARTED + 30_000 };
    expect(observe(before, before.lastSeen + HOUR)).toEqual({
      spentMs: 30_000 + STEP_CAP_MS,
      lastSeen: before.lastSeen + HOUR,
    });
    expect(STEP_CAP_MS).toBe(60_000);
  });

  test("a wall clock set backwards adds nothing, and the next look counts from where it reads now", () => {
    const before = { spentMs: 30_000, lastSeen: STARTED + 30_000 };
    const back = observe(before, before.lastSeen - HOUR);
    expect(back).toEqual({ spentMs: 30_000, lastSeen: before.lastSeen - HOUR });
    expect(observe(back, back.lastSeen + 2_000).spentMs).toBe(32_000);
  });
});
