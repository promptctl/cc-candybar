import type {
  CacheEntry,
  RenderCacheObservers,
} from "../../src/daemon/cache/render";
import { DEBOUNCE_MS } from "../../src/daemon/cache/watchers";

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
//    deadline: a slower machine retries more and still passes; a watcher
//    that never delivers is Jest's own test timeout, loud and carrying the
//    test's name. The tests' previous "give fs.watch a moment" sleeps were
//    this same fact, bet on instead of proven.
export class ReloadSignal {
  private readonly waiters = new Map<CacheEntry, Array<() => void>>();

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
  // does not — pair it with a rewrite).
  async after(entry: CacheEntry, mutate: () => void): Promise<void> {
    for (;;) {
      const reloaded = this.next(entry);
      mutate();
      if (await arrivesWithin(reloaded, RETRY_MS)) return;
    }
  }

  private next(entry: CacheEntry): Promise<void> {
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

function arrivesWithin(signal: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void signal.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
