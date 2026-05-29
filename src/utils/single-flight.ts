// [LAW:one-source-of-truth] A keyed in-flight coalescer: while a computation
// for a given key is running, every concurrent caller for that same key shares
// the ONE in-flight promise instead of starting its own. The fs gate
// (transcript-fs.ts) bounds how many fs ops run at once; it does NOT dedupe the
// work — K concurrent renders each still launch their own (now-bounded)
// whole-tree scan. This is the missing piece: K renders trigger ONE scan, not
// K. The gate makes that one scan's cost bounded; this makes there be one.
//
// [LAW:types-are-the-program] Coalescing is expressed by ROUTING through one
// owner of "is this key already computing", not by a guard scattered at each
// callsite. The selection is dataflow — `inflight.get(key) ?? start(...)` —
// both arms yield a `Promise<T>`, so the operation (return the shared promise)
// always runs; only the value varies. There is no `if (alreadyRunning) return`
// branch that skips work.
//
// Scope of sharing is exactly the in-flight WINDOW: the entry is removed when
// the promise settles (success OR failure), so this is a coalescer, never a
// cache. A fresh call after completion starts a new computation — staleness is
// impossible because nothing is retained past settle. Result caching, when
// wanted, is a separate concern owned by the caller (the disk/LRU caches).
//
// This also dissolves the render-timeout orphaning problem
// (brandon-daemon-memory-leak-gn4.3): a render that abandons its await (the
// daemon's 200ms response timeout fires) does not cancel or duplicate the
// shared computation — there is only ever one scan in flight per key, so the
// timed-out render leaves behind the single canonical computation that the next
// render coalesces onto. A timeout therefore adds zero new fs work.
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  run<T>(key: string, factory: () => Promise<T>): Promise<T> {
    return (
      (this.inflight.get(key) as Promise<T> | undefined) ??
      this.start(key, factory)
    );
  }

  private start<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const promise = factory();
    this.inflight.set(key, promise);
    // Deregister on settle. The identity check guards the (impossible-by-key
    // but cheap-to-prove) case where a newer promise has replaced this one:
    // only the promise that registered itself clears itself.
    const deregister = (): void => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    };
    promise.then(deregister, deregister);
    return promise;
  }

  // Number of computations currently in flight. Exposed for the daemon stats
  // snapshot and the verification harness — observers, not control flow.
  get size(): number {
    return this.inflight.size;
  }
}
