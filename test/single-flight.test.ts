// [LAW:behavior-not-structure] Contract of the in-flight coalescer: while a key
// is computing, concurrent callers share ONE promise; once it settles the entry
// is gone (coalescer, never a cache); distinct keys never interfere; a rejection
// is shared by every waiter and clears the slot so the next call retries.

import { SingleFlight } from "../src/utils/single-flight";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SingleFlight", () => {
  test("concurrent callers of one key share a single factory run", async () => {
    const flight = new SingleFlight();
    let runs = 0;
    const d = deferred<number>();
    const factory = () => {
      runs++;
      return d.promise;
    };

    const a = flight.run("k", factory);
    const b = flight.run("k", factory);
    const c = flight.run("k", factory);

    expect(runs).toBe(1);
    expect(flight.size).toBe(1);

    d.resolve(42);
    expect(await Promise.all([a, b, c])).toEqual([42, 42, 42]);
    expect(runs).toBe(1);
  });

  test("the slot is released on settle — a later call re-runs", async () => {
    const flight = new SingleFlight();
    let runs = 0;
    const factory = () => {
      runs++;
      return Promise.resolve(runs);
    };

    expect(await flight.run("k", factory)).toBe(1);
    expect(flight.size).toBe(0);
    // Settled → not cached → fresh computation.
    expect(await flight.run("k", factory)).toBe(2);
    expect(runs).toBe(2);
  });

  test("a rejection is shared by all waiters and clears the slot", async () => {
    const flight = new SingleFlight();
    let runs = 0;
    const d = deferred<number>();
    const factory = () => {
      runs++;
      return d.promise;
    };

    const a = flight.run("k", factory);
    const b = flight.run("k", factory);
    expect(runs).toBe(1);

    d.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");

    // Slot cleared on rejection → a fresh call retries rather than re-throwing
    // the stale failure.
    expect(flight.size).toBe(0);
    const ok = await flight.run("k", () => Promise.resolve(7));
    expect(ok).toBe(7);
  });

  test("distinct keys run independently and concurrently", async () => {
    const flight = new SingleFlight();
    const da = deferred<string>();
    const db = deferred<string>();

    const a = flight.run("a", () => da.promise);
    const b = flight.run("b", () => db.promise);
    expect(flight.size).toBe(2);

    db.resolve("B");
    expect(await b).toBe("B");
    expect(flight.size).toBe(1);

    da.resolve("A");
    expect(await a).toBe("A");
    expect(flight.size).toBe(0);
  });
});
