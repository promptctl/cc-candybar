import type {
  ReloadedEntry,
  RenderCacheObservers,
} from "../../src/daemon/cache/render";
import { DEBOUNCE_MS } from "../../src/daemon/cache/watchers";

// [LAW:no-ambient-temporal-coupling] A happens-after gate over RenderCache reloads.
// fs.watch has no ready signal, so the only proof a watcher is live is a delivered
// event: `after` re-applies the mutation until a reload observes it.
export class ReloadSignal {
  private readonly waiters = new Map<ReloadedEntry, Array<() => void>>();

  readonly observers: RenderCacheObservers = {
    onReload: (entry) => {
      const resolvers = this.waiters.get(entry) ?? [];
      this.waiters.delete(entry);
      for (const resolve of resolvers) resolve();
    },
  };

  // `mutate` must leave the same final disk state AND emit an fs event on every call.
  async after(entry: ReloadedEntry, mutate: () => void): Promise<void> {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const reloaded = this.next(entry);
      mutate();
      if (await arrivesWithin(reloaded, RETRY_MS)) return;
    }
    throw new Error(
      `no reload observed for ${entry.projectDir} after ${MAX_ROUNDS} mutations (${MAX_ROUNDS * RETRY_MS} ms)`,
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

// [LAW:one-source-of-truth] A retry must outwait the registry's own debounce floor.
const RETRY_MS = 4 * DEBOUNCE_MS;
// Below Jest's 30 s testTimeout, so a dead watcher fails as this error.
const MAX_ROUNDS = 64;

function arrivesWithin(signal: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void signal.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
