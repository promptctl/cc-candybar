// [LAW:behavior-not-structure] An update act's budget is spent in the waits
// between a daemon's looks at its job: a wait past the longest look (a sleep,
// a stalled daemon) is kept apart as unwatched, a slow look is not a wait,
// and a wedged act on an awake machine still runs the budget out.
import {
  looked,
  type ActRecord,
  type Look,
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

// Looks that each begin and end at once, at the given times.
const looks = (times: readonly number[], of: ActRecord = JOB): Look[] =>
  times.reduce<{ watched: Watched | null; seen: Look[] }>(
    ({ watched, seen }, now) => {
      const look = looked(watched, of, at(now), at(now), LONGEST_LOOK_MS);
      return { watched: look.watched, seen: [...seen, look] };
    },
    { watched: null, seen: [] },
  ).seen;
const last = (times: readonly number[]): Watched => looks(times).at(-1)!.watched;

describe("the time a daemon watched an act's job", () => {
  test("a first look spends nothing", () => {
    expect(looks([5_000])).toEqual([
      {
        kind: "first",
        watched: {
          job: JOB,
          spentMs: 0,
          unwatchedMs: 0,
          lookedAt: 5_000,
          ended: false,
        },
      },
    ]);
  });

  test("looks a poll apart spend the poll each", () => {
    expect(last([0, 2_000, 4_000, 6_000]).spentMs).toBe(6_000);
  });

  test("a wait of the longest look is spent; one past it is unwatched", () => {
    expect(looks([0, LONGEST_LOOK_MS])[1]).toMatchObject({
      kind: "spent",
      waitedMs: LONGEST_LOOK_MS,
    });
    expect(looks([0, LONGEST_LOOK_MS + 1])[1]).toMatchObject({
      kind: "unwatched",
      waitedMs: LONGEST_LOOK_MS + 1,
      watched: { spentMs: 0, unwatchedMs: LONGEST_LOOK_MS + 1 },
    });
  });

  test("an hour's sleep is unwatched, and the looks around it spend", () => {
    expect(last([0, 2_000, 2_000 + 3_600_000, 3_604_000])).toMatchObject({
      spentMs: 4_000,
      unwatchedMs: 3_600_000,
    });
  });

  // Under load a read can take longer than the longest look; the wait
  // between looks is what counts, so the read's own time is neither spent
  // nor unwatched.
  test("a look slower than the longest look is still followed by a spent wait", () => {
    const first = looked(null, JOB, at(0), at(30_000), LONGEST_LOOK_MS);
    const next = looked(first.watched, JOB, at(32_000), at(62_000), LONGEST_LOOK_MS);
    expect(next).toMatchObject({
      kind: "spent",
      waitedMs: 2_000,
      watched: { spentMs: 2_000, unwatchedMs: 0, lookedAt: 62_000 },
    });
  });

  // An act's number is claimed again once its directory is gone, so the
  // spend follows the job, not the number.
  test("another job starts unspent", () => {
    const watched = last([0, 2_000, 4_000]);
    expect(looked(watched, job(2), at(6_000), at(6_000), LONGEST_LOOK_MS)).toMatchObject({
      kind: "first",
      watched: { job: job(2), spentMs: 0 },
    });
    expect(
      looked(watched, job(1, "other"), at(6_000), at(6_000), LONGEST_LOOK_MS)
        .kind,
    ).toBe("first");
  });

  test("a job once ended stays ended through later looks", () => {
    const watched = { ...last([0, 2_000]), ended: true };
    expect(
      looked(watched, JOB, at(4_000), at(4_000), LONGEST_LOOK_MS).watched.ended,
    ).toBe(true);
  });

  // A dark wake spends the polls it stays awake for after its first look.
  test("a weekend of 240 dark wakes of one poll each spends eight minutes", () => {
    const hour = 3_600_000;
    const times = Array.from({ length: 240 }, (_, i) => [
      i * (hour / 4),
      i * (hour / 4) + 2_000,
    ]).flat();
    expect(last(times).spentMs).toBe(240 * 2_000);
  });
});
