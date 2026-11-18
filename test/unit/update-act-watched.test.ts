// [LAW:behavior-not-structure] An update act's budget is spent in spans a
// daemon watched its job run: a span past the longest look (a sleep, a
// stalled daemon) is kept apart as unwatched, and a wedged act on an awake
// machine still runs the budget out.
import {
  watchedAt,
  type ActRecord,
  type Watched,
} from "../../src/daemon/update-act";
import { LONGEST_LOOK_MS } from "../../src/daemon/update-notice";
import type { Monotonic } from "../../src/time";

const job = (pid: number, startTime: string | null = "t"): ActRecord => ({
  identity: "id",
  pid,
  startTime,
  started: 0,
});
const JOB = job(1);
const at = (ms: number) => ms as Monotonic;
const looks = (times: readonly number[], of: ActRecord = JOB): Watched =>
  times.reduce<Watched | null>(
    (w, now) => watchedAt(w, of, at(now), LONGEST_LOOK_MS),
    null,
  )!;

describe("the time a daemon watched an act's job", () => {
  test("a first look spends nothing", () => {
    expect(looks([5_000])).toEqual({
      job: JOB,
      spentMs: 0,
      unwatchedMs: 0,
      lookedAt: 5_000,
    });
  });

  test("looks a poll apart spend the poll each", () => {
    expect(looks([0, 2_000, 4_000, 6_000]).spentMs).toBe(6_000);
  });

  test("a span of the longest look is spent; one past it is unwatched", () => {
    expect(looks([0, LONGEST_LOOK_MS])).toMatchObject({
      spentMs: LONGEST_LOOK_MS,
      unwatchedMs: 0,
    });
    expect(looks([0, LONGEST_LOOK_MS + 1])).toMatchObject({
      spentMs: 0,
      unwatchedMs: LONGEST_LOOK_MS + 1,
    });
  });

  test("an hour's sleep is unwatched, and the looks around it spend", () => {
    expect(looks([0, 2_000, 2_000 + 3_600_000, 3_604_000])).toEqual({
      job: JOB,
      spentMs: 4_000,
      unwatchedMs: 3_600_000,
      lookedAt: 3_604_000,
    });
  });

  // An act's number is claimed again once its directory is gone, so the
  // spend follows the job, not the number.
  test("another job starts unspent, under any act number", () => {
    const first = looks([0, 2_000, 4_000]);
    expect(watchedAt(first, job(2), at(6_000), LONGEST_LOOK_MS)).toEqual({
      job: job(2),
      spentMs: 0,
      unwatchedMs: 0,
      lookedAt: 6_000,
    });
    expect(
      watchedAt(first, job(1, "other"), at(6_000), LONGEST_LOOK_MS).spentMs,
    ).toBe(0);
  });

  // A dark wake spends the polls it stays awake for after its first look.
  test("a weekend of 240 dark wakes of one poll each spends eight minutes", () => {
    const hour = 3_600_000;
    const times = Array.from({ length: 240 }, (_, i) => [
      i * (hour / 4),
      i * (hour / 4) + 2_000,
    ]).flat();
    expect(looks(times).spentMs).toBe(240 * 2_000);
  });
});
