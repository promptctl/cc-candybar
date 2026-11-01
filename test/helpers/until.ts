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

// How a wait ended: the condition held, or the budget expired. At expiry a
// probe may still be in flight; it is handed back so the caller decides what
// its late answer means.
export type Ending =
  | { kind: "held" }
  | { kind: "expired"; inFlight: Promise<void> | null };

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
// honoured whichever settled first, and only a probe still in flight at
// expiry is handed back.
// [LAW:one-source-of-truth] THE poll loop: both named waits below, and the
// watch-liveness retry's rounds, are one loop with the two outcomes named, so
// no test file keeps a copy that answers false at its deadline.
export async function holdsWithin(
  reached: Condition,
  budgetMs: number,
): Promise<Ending> {
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
      let inFlight: Promise<void> | null = null;
      if (typeof result === "boolean") seen.answer = result;
      else {
        const probe = result.then(
          (held) => { seen.answer = held; },
          (error) => { seen.failure = { error }; },
        );
        await Promise.race([probe, expiry]);
        if (seen.failure) throw seen.failure.error;
        if (seen.answer === undefined)
          inFlight = probe.then(() => {
            if (seen.failure) throw seen.failure.error;
          });
      }
      if (seen.answer) return { kind: "held" };
      if (seen.answer === undefined) return { kind: "expired", inFlight };
      if (expired) return { kind: "expired", inFlight: null };
      await sleep(TICK_MS);
    }
  } finally {
    stop.abort();
  }
}

// A named condition, polled until it holds or loudly failed at its budget —
// never a sleep standing in for it, and never a silent give-up that leaves
// the next assertion to fail without the cause. A probe left in flight is
// dropped: the wait has already failed by name, so its late answer is moot.
export async function until(
  reached: Condition,
  what: What,
  budgetMs = 5_000,
): Promise<void> {
  const ending = await holdsWithin(reached, budgetMs);
  if (ending.kind === "held") return;
  ending.inFlight?.catch(() => undefined);
  throw new Error(`${nameOf(what)} did not hold within ${budgetMs}ms`);
}

// The complement: a named condition that must keep holding for the whole
// budget. "It never happened within the budget" is a real answer a test
// asserts (a blocked spawn stays blocked), so it has its own loud name
// rather than a false read out of `until`. Expiry is the pass here, so a
// probe left in flight is awaited: its late throw lands on the caller's own
// await, not in whichever test file is running by then. [LAW:no-silent-failure]
export async function throughout(
  holds: Condition,
  what: What,
  budgetMs: number,
): Promise<void> {
  const ending = await holdsWithin(async () => !(await holds()), budgetMs);
  if (ending.kind === "held")
    throw new Error(`${nameOf(what)} stopped holding within ${budgetMs}ms`);
  await ending.inFlight;
}
