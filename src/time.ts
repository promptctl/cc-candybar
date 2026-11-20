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

// [LAW:one-type-per-behavior] A monotonic reading, so one cannot be passed
// where a wall time is meant, or the reverse: the two differ by decades.
export type Monotonic = number & { readonly __monotonic: true };

// Work the clock runs for its owner: nothing awaits it, so what it returns,
// a promise included, is the clock's to settle.
export type Task = () => unknown;

export interface Timekeeper {
  // Wall time, in epoch milliseconds: the one wall reading. A `Date` is
  // `new Date(clock.now())`, and a file's age is `clock.now() - mtimeMs`.
  now(): number;
  // Milliseconds since an arbitrary start that never steps back, for spans.
  monotonic(): Monotonic;
  // [LAW:nothing-unseen] Every task is named, in the words a person reads
  // when it throws: `git refresh /repo`, not an id. Required, so no task the
  // clock runs is anonymous.
  //
  // Runs `fire` on a later turn, once `ms` have passed, unless what it returns
  // clears it first. Never before it returns: its callers arm it before they
  // are ready to be fired at.
  after(
    task: string,
    ms: number,
    fire: Task,
    options?: TimerOptions,
  ): () => void;
  // Runs `fire` every `ms` until what it returns clears it.
  every(
    task: string,
    ms: number,
    fire: Task,
    options?: TimerOptions,
  ): () => void;
  // Runs `fire` on the loop's next turn, after the work now running.
  defer(task: string, fire: Task): () => void;
  // Runs `fire` now, and nothing awaits it: the one way to start work whose
  // end no caller waits on.
  detach(task: string, fire: Task): void;
}

// Where a clock hands a task's throw or rejection.
export type ReportThrow = (task: string, thrown: unknown) => void;

// [LAW:single-enforcer] A clock whose tasks cannot throw past it: what one
// throws, or rejects with, goes to `report` under the task's name, and the
// task is otherwise run as `clock` runs it. An `every` keeps firing after a
// throw, as an interval does.
export function reporting(clock: Timekeeper, report: ReportThrow): Timekeeper {
  const guarded = (task: string, fire: Task) => (): void => {
    try {
      void Promise.resolve(fire()).catch((thrown: unknown) =>
        report(task, thrown),
      );
    } catch (thrown) {
      report(task, thrown);
    }
  };
  return {
    now: () => clock.now(),
    monotonic: () => clock.monotonic(),
    after: (task, ms, fire, options) =>
      clock.after(task, ms, guarded(task, fire), options),
    every: (task, ms, fire, options) =>
      clock.every(task, ms, guarded(task, fire), options),
    defer: (task, fire) => clock.defer(task, guarded(task, fire)),
    detach: (task, fire) => guarded(task, fire)(),
  };
}

// [LAW:single-enforcer] A span in whole milliseconds between two monotonic
// readings: every duration src records or prints is one of these.
export function spanMs(from: Monotonic, to: Monotonic): number {
  return Math.round(to - from);
}

// A span from `since` to now.
export function elapsedMs(
  clock: Pick<Timekeeper, "monotonic">,
  since: Monotonic,
): number {
  return spanMs(since, clock.monotonic());
}

// [LAW:single-enforcer] The one place src reads the real clock, sets a timer
// or waits for a loop turn. It holds no state; `after` and `every` read the
// timer globals when they are called, so jest's fake timers still drive code
// handed it. `defer` is `node:timers`' own, which jest's fakes leave alone.
export const systemTimekeeper: Timekeeper = {
  now: () => Date.now(),
  monotonic: () => performance.now() as Monotonic,
  // The name is for a clock that reports (`reporting`); this one runs the task
  // bare, so a throw reaches the process's own handlers.
  after: (_task, ms, fire, options) => {
    const timer = setTimeout(fire, ms);
    if (options?.unref) {
      timer.unref();
    }
    return () => clearTimeout(timer);
  },
  every: (_task, ms, fire, options) => {
    const timer = setInterval(fire, ms);
    if (options?.unref) {
      timer.unref();
    }
    return () => clearInterval(timer);
  },
  defer: (_task, fire) => {
    const turn = setImmediate(fire);
    return () => clearImmediate(turn);
  },
  detach: (_task, fire) => {
    void fire();
  },
};

// Hands what awaited work threw to the clock, as a task of its own that throws
// it: for an owner that must go on past the throw, as a loop takes its next
// pass. A reporting clock reports it; a bare one throws it here.
export function told(
  clock: Pick<Timekeeper, "detach">,
  task: string,
  thrown: unknown,
): void {
  clock.detach(task, () => {
    throw thrown;
  });
}

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
    const cancel = clock.after("sleep", ms, () => {
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
    "timeout signal",
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
