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
  // emit an fs event on every call (a plain overwrite does; a bare unlink
  // does not — pair it with a rewrite). The subscription is taken in the
  // same synchronous block as the mutation, so fact 1 above holds per round.
  async after(entry: ReloadedEntry, mutate: () => void): Promise<void> {
    let observed = false;
    await untilHeard(
      () => {
        void this.next(entry).then(() => {
          observed = true;
        });
        mutate();
      },
      () => observed,
      `a reload of ${entry.projectDir}`,
    );
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
const RETRY_MS = 4 * DEBOUNCE_MS;
// 64 fresh chances (~13 s at the cadence above): far above any delivery
// latency seen, below Jest's 30 s testTimeout so the failure is this error.
const MAX_ROUNDS = 64;

// [LAW:single-enforcer] THE retry-until-heard loop for a watch: `mutate` is
// applied at once and then once per round until `heard` holds within the
// round's cadence, or the wait fails by name after MAX_ROUNDS rounds. Only a
// delivered event proves a watch live, so `after` is this loop with "heard"
// being a reload, and a test that drives a watch itself passes the condition
// it reads. `mutate` must emit an fs event on every call (a rename over the
// path or a plain overwrite does), and `heard` is read until it holds, so a
// condition over something a later event can move (a count) must be
// at-least, never exactly. [LAW:no-silent-failure] A throw from `mutate`
// lands on the caller's own await, not in a detached timer callback.
export async function untilHeard(
  mutate: () => void,
  heard: Condition,
  what: What,
): Promise<void> {
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    mutate();
    const ending = await holdsWithin(heard, RETRY_MS);
    if (ending.kind === "held") return;
    ending.inFlight?.catch(() => undefined);
  }
  throw new Error(
    `${nameOf(what)} did not hold after ${MAX_ROUNDS} mutations (${MAX_ROUNDS * RETRY_MS} ms)`,
  );
}
