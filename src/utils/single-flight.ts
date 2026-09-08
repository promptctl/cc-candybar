// [LAW:one-source-of-truth] A keyed in-flight coalescer: concurrent callers for one
// key share the ONE running promise, so K renders trigger ONE scan, not K. Sharing is
// exactly the in-flight WINDOW — the entry goes on settle, so this is a coalescer,
// never a cache. [LAW:types-are-the-program] Selection is dataflow, not a skip branch.
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
    // Only the promise that registered itself clears itself.
    const deregister = (): void => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    };
    promise.then(deregister, deregister);
    return promise;
  }

  // Read-only observability for tests. Never read as control flow.
  get size(): number {
    return this.inflight.size;
  }
}
