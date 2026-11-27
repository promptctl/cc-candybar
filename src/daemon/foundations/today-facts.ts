import type { ZonedCalendar } from "../../utils/calendar.js";
import type { TokenBreakdown } from "../../segments/session";
import { ABSENT, ok, type Outcome } from "../../utils/outcome";
import { dateOf, type Instant } from "../../utils/instant";
import type { DayUsage, TodayFacts } from "../../facts/world-state";

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

// Day sums holding one day: `cost` and `tokens` on the day `at` falls in. What
// a test fixture holds in place of a scan.
export function oneDay(
  calendar: ZonedCalendar,
  at: Instant,
  cost: number,
  tokens: number,
): Readonly<Record<string, DayUsage>> {
  return {
    [calendar.dayKey(dateOf(at))]: { ...EMPTY_DAY, cost, input: tokens },
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

// [LAW:one-source-of-truth] The `today` projection at a draw's instant: the
// day of the fact the instant is in, so a frame past midnight sums the new day
// with no refresh and no owner moving. `absent` when the day holds nothing.
export function projectToday(
  facts: TodayFacts,
  at: Instant,
  calendar: ZonedCalendar,
): Outcome<TodayInfo> {
  const today = calendar.dayKey(dateOf(at));
  const inSet = facts.sums[today];
  const own = facts.own[today];
  if (inSet === undefined && own === undefined) return ABSENT;

  const total: DayUsage = { ...EMPTY_DAY };
  if (inSet !== undefined) addDay(total, inSet);
  if (own !== undefined) addDay(total, own);
  return ok({
    cost: total.cost,
    tokens: total.input + total.output + total.cacheCreation + total.cacheRead,
    tokenBreakdown: {
      input: total.input,
      output: total.output,
      cacheCreation: total.cacheCreation,
      cacheRead: total.cacheRead,
    },
    date: today,
  });
}
