import { totalTokens, type TokenBreakdown } from "../../segments/session";
import { ABSENT, ok, type Outcome } from "../../utils/outcome";
import { dateOf, type Instant } from "../../utils/instant";

// The `today` fact and its projection, apart from the store that remembers the
// records (session-usage-store.ts): a draw's day is a pure function of the
// fact and the draw's instant, so what reads it (the draw, `check`, the demo)
// does not load the store's pricing, transcript reads or observables.

// Per-(session, day) scalar contribution — the only granularity the today fold
// needs. Raw entries are discarded after bucketing, so per-session retained
// memory is O(retained-days), not O(entries).
export interface DayUsage {
  cost: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export const EMPTY_DAY: DayUsage = {
  cost: 0,
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
};

export function addDay(into: DayUsage, d: DayUsage): void {
  into.cost += d.cost;
  into.input += d.input;
  into.output += d.output;
  into.cacheCreation += d.cacheCreation;
  into.cacheRead += d.cacheRead;
}

export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Day sums holding one day: `cost` and `tokens` on the day `at` falls in. What
// a fixture (`check`, a test) holds in place of a scan.
export function oneDay(
  at: Instant,
  cost: number,
  tokens: number,
): Readonly<Record<string, DayUsage>> {
  return {
    [dayKey(dateOf(at))]: { ...EMPTY_DAY, cost, input: tokens },
  };
}

// [LAW:types-are-the-program] An `ok` TodayInfo always carries real totals —
// "no usage recorded today" is the `absent` outcome arm, not a bag of nulls.
export interface TodayInfo {
  cost: number;
  tokens: number;
  tokenBreakdown: TokenBreakdown;
  date: string;
}

// [LAW:types-are-the-program] Everything the `today` projection reads: the
// directory set's day sums, and the rendering session's own days the sums do
// not hold (a session whose transcript lies outside the set's projects; one
// under them is in `sums` already, so its `own` is empty). The session's
// ingest failing is not a field, it is the fact failing.
export interface TodayFacts {
  readonly sums: Readonly<Record<string, DayUsage>>;
  readonly own: Readonly<Record<string, DayUsage>>;
}

// [LAW:one-source-of-truth] The `today` projection at a draw's instant: the
// day of the fact the instant is in, so a frame past midnight sums the new day
// with no refresh and no owner moving. `absent` when the day holds nothing.
export function projectToday(
  facts: TodayFacts,
  at: Instant,
): Outcome<TodayInfo> {
  const today = dayKey(dateOf(at));
  const inSet = facts.sums[today];
  const own = facts.own[today];
  if (inSet === undefined && own === undefined) return ABSENT;

  const total: DayUsage = { ...EMPTY_DAY };
  if (inSet !== undefined) addDay(total, inSet);
  if (own !== undefined) addDay(total, own);
  return ok({
    cost: total.cost,
    tokens: totalTokens(total),
    tokenBreakdown: {
      input: total.input,
      output: total.output,
      cacheCreation: total.cacheCreation,
      cacheRead: total.cacheRead,
    },
    date: today,
  });
}
