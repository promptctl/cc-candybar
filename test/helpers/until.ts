import { setTimeout as sleep } from "node:timers/promises";

export type Condition = () => boolean | Promise<boolean>;

// What was waited on, for the failure. A thunk is read only when the wait
// fails, so it can carry what the last probe saw.
export type What = string | (() => string);

// [LAW:one-source-of-truth] The tick is the watcher debounce: a probe that
// writes (the idempotent rewrite a watcher test repeats until delivery)
// lands one write per delivery window, not five.
const TICK_MS = 50;

export const nameOf = (what: What): string =>
  typeof what === "string" ? what : what();

// [LAW:no-ambient-temporal-coupling] The budget is one real sleep, never a
// deadline read off a clock. Jest's fake timers freeze Date, hrtime and
// performance, and sinon would fake node:timers/promises too were the clock
// installed on the real global; jest installs it on the sandbox's global, so
// the module keeps real time there, and a test that fakes the clock for the
// code it drives still gets a real deadline on what it waits for.
// [LAW:dataflow-not-control-flow] A synchronous probe answers synchronously
// and never enters a race. An asynchronous probe is raced against the
// budget so one that never answers (a connect to a bound socket nobody
// accepts) still ends the wait at its budget, but the outcome is read off
// what the probe wrote, not off which promise won: an answer that landed is
// honoured whichever settled first, and a probe still in flight at expiry
// is left behind, its late answer unread.
// [LAW:one-source-of-truth] THE poll loop: both named waits below, and the
// watch-liveness retry's rounds, are one loop with the two outcomes named, so
// no test file keeps a copy that answers false at its deadline.
export async function holdsWithin(
  reached: Condition,
  budgetMs: number,
): Promise<boolean> {
  const stop = new AbortController();
  let expired = false;
  const expiry = sleep(budgetMs, undefined, { signal: stop.signal }).then(
    () => { expired = true; },
    () => {},
  );
  try {
    for (;;) {
      const result = reached();
      const seen: { answer?: boolean; failure?: { error: unknown } } = {};
      if (typeof result === "boolean") seen.answer = result;
      else {
        const probe = result.then(
          (held) => { seen.answer = held; },
          (error) => { seen.failure = { error }; },
        );
        await Promise.race([probe, expiry]);
        if (seen.failure) throw seen.failure.error;
      }
      if (seen.answer) return true;
      if (seen.answer === undefined || expired) return false;
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
  if (await holdsWithin(reached, budgetMs)) return;
  throw new Error(`${nameOf(what)} did not hold within ${budgetMs}ms`);
}

// The complement: a named condition that must keep holding for the whole
// budget. "It never happened within the budget" is a real answer a test
// asserts (a blocked spawn stays blocked), so it has its own loud name
// rather than a false read out of `until`. [LAW:types-are-the-program] `holds`
// is synchronous because expiry is the pass here: an unanswered probe would
// pass without having answered.
export async function throughout(
  holds: () => boolean,
  what: What,
  budgetMs: number,
): Promise<void> {
  if (await holdsWithin(() => !holds(), budgetMs))
    throw new Error(`${nameOf(what)} stopped holding within ${budgetMs}ms`);
}
