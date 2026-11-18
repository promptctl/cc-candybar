// [LAW:behavior-not-structure] An update act's budget is spent in time a
// daemon watched it run, so a sleep, a stalled daemon or a clock set back
// spends nothing, and a wedged act on an awake machine still runs it out.
import { watchedAt, type Watched } from "../../src/daemon/update-act";

const LONGEST = 10_000;
const looks = (start: Watched | null, act: number, at: readonly number[]) =>
  at.reduce<Watched | null>((w, now) => watchedAt(w, act, now, LONGEST), start);

describe("the time a daemon watched an act", () => {
  test("a first look spends nothing", () => {
    expect(watchedAt(null, 1, 5_000, LONGEST)).toEqual({
      act: 1,
      spentMs: 0,
      lookedAt: 5_000,
    });
  });

  test("looks a poll apart spend the poll each", () => {
    expect(looks(null, 1, [0, 2_000, 4_000, 6_000])?.spentMs).toBe(6_000);
  });

  test("a gap past the longest look is a sleep and spends nothing", () => {
    expect(looks(null, 1, [0, 2_000, 2_000 + 3_600_000, 3_604_000])).toEqual({
      act: 1,
      spentMs: 4_000,
      lookedAt: 3_604_000,
    });
  });

  test("a clock set back spends nothing", () => {
    expect(looks(null, 1, [10_000, 4_000, 6_000])?.spentMs).toBe(2_000);
  });

  test("another act starts unspent", () => {
    const first = looks(null, 1, [0, 2_000, 4_000]);
    expect(watchedAt(first, 2, 6_000, LONGEST)).toEqual({
      act: 2,
      spentMs: 0,
      lookedAt: 6_000,
    });
  });

  // A dark wake is a look after a long gap and perhaps one more a poll
  // later: a weekend of them spends a few minutes, never ten.
  test("a weekend of 240 dark wakes spends under ten minutes", () => {
    const hour = 3_600_000;
    const at = Array.from({ length: 240 }, (_, i) => [
      i * (hour / 4),
      i * (hour / 4) + 2_000,
    ]).flat();
    // Eight minutes: one poll per wake.
    expect(looks(null, 1, at)!.spentMs).toBe(480_000);
  });
});
