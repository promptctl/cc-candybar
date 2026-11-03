import { clearImmediate, setImmediate } from "node:timers";

// [LAW:effects-at-boundaries] Time as an input: what the wall and the monotonic
// clock read, and when a later turn runs, handed to whatever needs them, so a
// test holds all of it by hand (test/helpers/held-clock.ts) and the real clock
// is this file alone. The eslint config keeps `Date.now`, `performance.now`, a
// zero-argument `new Date`, the timer globals and `node:timers` out of every
// other file in src.
export interface TimerOptions {
  // The timer does not keep the process alive, as `timer.unref()` does.
  readonly unref?: boolean;
}

export interface Timekeeper {
  // Wall time, in epoch milliseconds: the one wall reading. A `Date` is
  // `new Date(clock.now())`, and a file's age is `clock.now() - mtimeMs`.
  now(): number;
  // Milliseconds since an arbitrary start that never steps back, for spans.
  monotonic(): number;
  // Runs `fire` on a later turn, once `ms` have passed, unless what it returns
  // clears it first. Never before it returns: its callers arm it before they
  // are ready to be fired at.
  after(ms: number, fire: () => void, options?: TimerOptions): () => void;
  // Runs `fire` every `ms` until what it returns clears it.
  every(ms: number, fire: () => void, options?: TimerOptions): () => void;
  // Runs `fire` on the loop's next turn, after the work now running.
  defer(fire: () => void): () => void;
}

// [LAW:single-enforcer] A span in whole milliseconds since `since`, a
// monotonic reading: every duration src records or prints is one of these.
export function elapsedMs(
  clock: Pick<Timekeeper, "monotonic">,
  since: number,
): number {
  return Math.round(clock.monotonic() - since);
}

// [LAW:single-enforcer] The one place src reads the real clock, sets a timer
// or waits for a loop turn. It holds no state; `after` and `every` read the
// timer globals when they are called, so jest's fake timers still drive code
// handed it. `defer` is `node:timers`' own, which jest's fakes leave alone.
export const systemTimekeeper: Timekeeper = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  after: (ms, fire, options) => {
    const timer = setTimeout(fire, ms);
    if (options?.unref) {
      timer.unref();
    }
    return () => clearTimeout(timer);
  },
  every: (ms, fire, options) => {
    const timer = setInterval(fire, ms);
    if (options?.unref) {
      timer.unref();
    }
    return () => clearInterval(timer);
  },
  defer: (fire) => {
    const turn = setImmediate(fire);
    return () => clearImmediate(turn);
  },
};

// One implementation of the wait, over `after`, so a held clock drives it.
// Ends as `timers/promises`' sleep does: a signal that aborts it rejects with
// an `AbortError` whose `cause` is the signal's reason.
export function sleep(
  clock: Pick<Timekeeper, "after">,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () =>
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
        cause: signal?.reason,
      });
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = () => {
      cancel();
      reject(aborted());
    };
    const cancel = clock.after(ms, () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// `AbortSignal.timeout` over `after`: aborts with a `TimeoutError` once `ms`
// have passed, and does not keep the process alive while it waits.
export function timeoutSignal(
  clock: Pick<Timekeeper, "after">,
  ms: number,
): AbortSignal {
  const timeout = new AbortController();
  clock.after(
    ms,
    () =>
      timeout.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      ),
    { unref: true },
  );
  return timeout.signal;
}
