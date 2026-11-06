import { START_TIME_READ_BUDGET_MS } from "../../src/daemon/process-fingerprint";
import { CASE_TIME_LEFT } from "./case-clock.cjs";

// A wait's bound, and the words a failure names it by: its own budget, or the
// time its case had left when that ran out first.
export interface Wait {
  readonly ms: number;
  readonly named: string;
}

// [LAW:no-ambient-temporal-coupling] What a wait leaves Jest after its named
// failure, so that failure lands before Jest's own anonymous timeout. A wait
// checks its deadline between steps, so it can overrun it by one step, and the
// longest step is the pool's read of a slot owner's start time. A second on top
// is for what a failure does before it throws: killing the daemon and reading
// what it said.
const MARGIN_MS = START_TIME_READ_BUDGET_MS + 1_000;

// [LAW:parse-dont-validate] A budget is a finite number of milliseconds: an
// infinite one would reach a timer, which fires at once on it.
export function boundedBy(budgetMs: number, leftMs: number): Wait {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error(`a wait's budget is a finite number of ms, not ${budgetMs}`);
  }
  const room = Math.max(0, leftMs - MARGIN_MS);
  return room < budgetMs
    ? { ms: room, named: `the ${room}ms its case had left` }
    : { ms: budgetMs, named: `${budgetMs}ms` };
}

// The test environment publishes the case's time (test/helpers/case-clock.cjs).
// A host with no Jest, as `pnpm bar` is, runs no case, so no case bounds its
// waits.
const timeLeft =
  ((globalThis as Record<symbol, unknown>)[CASE_TIME_LEFT] as
    | (() => number)
    | undefined) ?? ((): number => Infinity);

// [LAW:one-source-of-truth] Every budgeted wait in a test is bounded through
// here, so their sum is the case's to bound, not each wait's to guess.
export function within(budgetMs: number): Wait {
  return boundedBy(budgetMs, timeLeft());
}

// The rest of the running case, for a wait whose bound is the case itself.
// [LAW:no-silent-failure] Outside a case there is no rest to wait out.
export function restOfCase(): number {
  const left = timeLeft();
  if (!Number.isFinite(left)) {
    throw new Error("restOfCase: no Jest case is running, so it has no time left to wait out");
  }
  return left;
}
