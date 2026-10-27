import { setTimeout as sleep } from "node:timers/promises";

export type Condition = () => boolean | Promise<boolean>;

// What was waited on, for the failure. A thunk is read only when the wait
// fails, so it can carry what the last probe saw.
export type What = string | (() => string);

const TICK_MS = 10;

const nameOf = (what: What): string =>
  typeof what === "string" ? what : what();

// [LAW:no-ambient-temporal-coupling] The budget is one real sleep, never a
// deadline read off a clock. Jest's fake timers freeze Date, hrtime and
// performance, and sinon would fake node:timers/promises too were the clock
// installed on the real global; jest installs it on the sandbox's global, so
// the module keeps real time there, and a test that fakes the clock for the
// code it drives still gets a real deadline on what it waits for. The
// deadline is read after each probe, not raced against it, so a wait ends
// at most one probe past its budget and never cuts a probe short.
// [LAW:one-source-of-truth] THE poll loop: both named waits below are one
// loop with the two outcomes named, so no test file keeps a copy that
// answers false at its deadline.
async function holdsWithin(
  reached: Condition,
  budgetMs: number,
): Promise<boolean> {
  const stop = new AbortController();
  let expired = false;
  void sleep(budgetMs, undefined, { signal: stop.signal }).then(
    () => { expired = true; },
    () => {},
  );
  try {
    for (;;) {
      if (await reached()) return true;
      if (expired) return false;
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
