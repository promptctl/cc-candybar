import fs from "node:fs";
import type {
  ReloadedEntry,
  RenderCacheObservers,
} from "../../src/daemon/cache/render";
import { DEBOUNCE_MS } from "../../src/daemon/cache/watchers";
import { holdsWithin, nameOf, type Condition, type What } from "./until";

// [LAW:no-ambient-temporal-coupling] A happens-after gate over RenderCache
// reloads, in place of polling an entry's fields against a wall-clock
// deadline — which was a bet that fs.watch + the reload beat the clock, and
// lost under a loaded parallel suite (brandon-testing-82q).
//
// Two temporal facts are closed here, and neither rides a clock:
//
// 1. "The reload ran after my write." A subscription is taken BEFORE the
//    mutation, the two are synchronous neighbours (no event-loop turn between
//    them), and a reload runs synchronously against the disk — so any reload
//    that resolves the subscription began after the mutation landed and
//    therefore observed it.
//
// 2. "The watcher was live when I wrote." fs.watch has no ready signal: on
//    macOS the FSEvents stream goes live asynchronously after fs.watch
//    returns, and a write landing before that is never reported. The only
//    proof of liveness is a delivered event, so `after` re-applies the
//    mutation until a reload observes it. RETRY_MS is a cadence, not a
//    deadline: a slower machine retries more and still passes. A watcher
//    that never delivers fails after MAX_ROUNDS with the count — below
//    Jest's test timeout, so the test's `finally` cleanup still runs. The
//    tests' previous "give fs.watch a moment" sleeps were this same fact,
//    bet on instead of proven.
export class ReloadSignal {
  private readonly waiters = new Map<ReloadedEntry, Array<() => void>>();

  // Hand this to `new RenderCache(deps, { observers })`.
  readonly observers: RenderCacheObservers = {
    onReload: (entry) => {
      const resolvers = this.waiters.get(entry) ?? [];
      this.waiters.delete(entry);
      for (const resolve of resolvers) resolve();
    },
  };

  // Apply `mutate` and resolve once a reload of `entry` has observed it —
  // success or failure alike; the caller asserts on the outcome it wanted.
  // `mutate` must leave the disk in the same final state on every call AND
  // emit an fs event on every call (a plain overwrite does; removing what is
  // already gone does not — `afterRemoving` is the removal). One
  // subscription, taken before the first mutation, is fact 1 above: every
  // mutation leaves the same state, so a reload that began after any of them
  // observed it. The condition is the reload's own promise, so the wait ends
  // on the event, not on a poll tick.
  async after(entry: ReloadedEntry, mutate: () => void): Promise<void> {
    const reloaded = this.next(entry).then(() => true);
    await untilHeard(mutate, () => reloaded, `a reload of ${entry.projectDir}`);
  }

  // [LAW:no-ambient-temporal-coupling] `after`, for removing `target`, a file
  // or a folder. Removing what is already gone emits nothing, so a round that
  // finds it missing lays it down with `layDown` first; the first round finds
  // it present and is a bare removal, the gesture under test. A writer
  // landing in a folder mid-removal (the storage owner's probe) is retried
  // rather than failing ENOTEMPTY.
  async afterRemoving(
    entry: ReloadedEntry,
    target: string,
    layDown: () => void,
  ): Promise<void> {
    await this.after(entry, () => {
      if (!fs.existsSync(target)) layDown();
      fs.rmSync(target, { recursive: true, maxRetries: 3 });
    });
  }

  private next(entry: ReloadedEntry): Promise<void> {
    return new Promise((resolve) => {
      const pending = this.waiters.get(entry) ?? [];
      pending.push(resolve);
      this.waiters.set(entry, pending);
    });
  }
}

// [LAW:one-source-of-truth] Derived from the registry's own debounce floor —
// a retry must at least outwait the debounce, or every round re-mutates before
// the first one could possibly have reloaded.
export const RETRY_MS = 4 * DEBOUNCE_MS;
// 48 fresh mutations: far above any delivery latency seen, and ~12 s at the
// cadence above (a round is the cadence plus at most one poll tick), so two
// waits in sequence still end below Jest's 30 s testTimeout and the failure
// is this error, with the test's cleanup run.
const MAX_ROUNDS = 48;

// [LAW:single-enforcer] THE retry-until-heard loop for a watch: `mutate` is
// applied at once and then once per round until `heard` holds, or the wait
// fails by name after MAX_ROUNDS rounds. Rounds refresh the mutation, not a
// probe still in flight.
// [LAW:one-source-of-truth] The cadence and the chances are the constants
// above, so every watch a test proves live gets the same budget. Only a
// delivered event proves a watch live, so `after` is this loop with "heard"
// being a reload, and a test that drives a watch itself passes the condition
// it reads. `mutate` must emit an fs event on every call (a rename over the
// path or a plain overwrite does), and `heard` is read until it holds, so a
// condition over something a later event can move (a count) must be
// at-least, never exactly. [LAW:no-silent-failure] A throw from `mutate`
// lands on the caller's own await, not in a detached timer callback.
// [LAW:no-ambient-temporal-coupling] One probe runs at a time: a probe still
// in flight when its round expires is carried into the next round, so its
// late answer counts and its late throw ends the wait, while the test that
// made it and its daemon are alive. [LAW:no-silent-failure] exception: a probe
// that outlasts every round goes unread and the wait fails by name; `after`'s
// never settles when no reload came.
export async function untilHeard(
  mutate: () => void,
  heard: Condition,
  what: What,
): Promise<void> {
  let asked: Promise<boolean> | null = null;
  const answer: Condition = () => {
    if (asked) return asked;
    const result = heard();
    if (typeof result === "boolean") return result;
    asked = result.then((held) => {
      if (!held) asked = null;
      return held;
    });
    return asked;
  };
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    mutate();
    if (await holdsWithin(answer, RETRY_MS)) return;
  }
  throw new Error(
    `${nameOf(what)} did not hold after ${MAX_ROUNDS} mutations ${RETRY_MS} ms apart`,
  );
}
