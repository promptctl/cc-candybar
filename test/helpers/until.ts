import { setTimeout as sleep } from "node:timers/promises";

export type Condition = () => boolean | Promise<boolean>;

// What was waited on, for the failure. A thunk is read only when the wait
// fails, so it can carry what the last probe saw.
export type What = string | (() => string);

const TICK_MS = 10;

const nameOf = (what: What): string =>
  typeof what === "string" ? what : what();

const EXPIRED = Symbol("expired");

// [LAW:no-ambient-temporal-coupling] The budget is one real sleep, never a
// deadline read off a clock. Jest's fake timers freeze Date, hrtime and
// performance, and sinon would fake node:timers/promises too were the clock
// installed on the real global; jest installs it on the sandbox's global, so
// the module keeps real time there, and a test that fakes the clock for the
// code it drives still gets a real deadline on what it waits for. Each probe
// is raced against the budget, so a probe that never answers (a connect to a
// bound socket nobody accepts) still ends the wait named at its budget; the
// probe left in flight is dropped, its late rejection swallowed.
// [LAW:one-source-of-truth] THE poll loop: both named waits below are one
// loop with the two outcomes named, so no test file keeps a copy that
// answers false at its deadline.
async function holdsWithin(
  reached: Condition,
  budgetMs: number,
): Promise<boolean> {
  const stop = new AbortController();
  const expiry: Promise<typeof EXPIRED> = sleep(budgetMs, EXPIRED, {
    signal: stop.signal,
  }).catch(() => EXPIRED);
  try {
    for (;;) {
      const probe = Promise.resolve().then(reached);
      const seen = await Promise.race([probe, expiry]);
      if (seen === true) return true;
      if (seen === EXPIRED) {
        probe.catch(() => undefined);
        return false;
      }
      await sleep(TICK_MS);
    }
  } finally {
    stop.abort();
  }
}

// A named condition, polled until it holds or loudly failed at its budget —
// never a sleep standing in for it, and never a silent give-up that leaves
// the next assertion to fail without the cause.
export async function until(
  reached: Condition,
  what: What,
  budgetMs = 5_000,
): Promise<void> {
  if (!(await holdsWithin(reached, budgetMs)))
    throw new Error(`${nameOf(what)} did not hold within ${budgetMs}ms`);
}

// The complement: a named condition that must keep holding for the whole
// budget. "It never happened within the budget" is a real answer a test
// asserts (a blocked spawn stays blocked), so it has its own loud name
// rather than a false read out of `until`.
export async function throughout(
  holds: Condition,
  what: What,
  budgetMs: number,
): Promise<void> {
  if (await holdsWithin(async () => !(await holds()), budgetMs))
    throw new Error(`${nameOf(what)} stopped holding within ${budgetMs}ms`);
}
