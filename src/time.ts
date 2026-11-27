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

// The machine's readings and timers, bare: what a clock is built over. Its
// timers take no task name, so a source never stands where a clock's task
// methods are asked for, and nothing holding one schedules a task whose throw
// goes unreported.
export interface TimerSource {
  now(): number;
  monotonic(): Monotonic;
  timer(ms: number, fire: () => void, options?: TimerOptions): () => void;
  interval(ms: number, fire: () => void, options?: TimerOptions): () => void;
  turn(fire: () => void): () => void;
}

// Work a clock runs for its owner. Nothing awaits it, so a promise it returns
// is the clock's to settle; any other value is dropped.
export type Task = () => unknown;

// Where a clock hands what a task threw or rejected with, under the task's
// name and the wall reading when it was caught.
export type ReportThrow = (task: string, thrown: unknown, at: number) => void;

export interface Timekeeper {
  // Wall time, in epoch milliseconds: the one wall reading. A `Date` is
  // `new Date(clock.now())`, and a file's age is `clock.now() - mtimeMs`.
  now(): number;
  // Milliseconds since an arbitrary start that never steps back, for spans.
  monotonic(): Monotonic;
  // [LAW:nothing-unseen] Every task is named in the words a person reads when
  // it throws: what it does, then its subject (`git refresh /repo`).
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
  // Runs `fire` every `ms` until what it returns clears it, past a throw too.
  every(
    task: string,
    ms: number,
    fire: Task,
    options?: TimerOptions,
  ): () => void;
  // Runs `fire` on the loop's next turn, after the work now running and after
  // the input already waiting when that turn comes: a timer's run that defers
  // lets a frame already on a socket be read first.
  defer(task: string, fire: Task): () => void;
  // Runs `fire` now, and nothing awaits it: the one way to start work whose
  // end no caller waits on. Its throw, sync or not, is settled as a rejection
  // is, so it never reaches the caller, whatever the clock reports to.
  detach(task: string, fire: Task): void;
  // Reports `thrown` as `task`'s throw, as a detached task's rejection is: the
  // one way an owner hands the clock a failure it holds as a value.
  failed(task: string, thrown: unknown): void;
}

// [LAW:single-enforcer] The one builder of a clock's task methods, so every
// task any clock runs reports what it throws: a sync throw or a rejection goes
// to `report`, and the task is otherwise run as the source runs it. A timer's
// sync throw is reported where it is caught, since only the loop is beneath
// it; a detached task's, as its rejection is, since its caller is.
export function clockOver(
  source: TimerSource,
  report: ReportThrow,
): Timekeeper {
  // [LAW:dataflow-not-control-flow] Whatever a task returned is settled: a
  // thenable, or a promise of another realm, rejects here as a native
  // promise does, and any other value settles at once.
  const settle = (task: string, settled: unknown): void =>
    void Promise.resolve(settled).catch((thrown: unknown) =>
      report(task, thrown, source.now()),
    );
  const run = (task: string, fire: Task) => (): void => {
    let settled: unknown;
    try {
      settled = fire();
    } catch (thrown) {
      report(task, thrown, source.now());
      return;
    }
    settle(task, settled);
  };
  return {
    now: () => source.now(),
    monotonic: () => source.monotonic(),
    after: (task, ms, fire, options) =>
      source.timer(ms, run(task, fire), options),
    every: (task, ms, fire, options) => {
      // The interval remains armed across calls. Its callback carries the
      // owner's task name into timer diagnostics for its whole lifetime.
      const callback = Object.defineProperty(run(task, fire), "name", {
        value: task,
      });
      return source.interval(ms, callback, options);
    },
    defer: (task, fire) => source.turn(run(task, fire)),
    detach: (task, fire) => {
      let settled: unknown;
      try {
        settled = fire();
      } catch (thrown) {
        settled = Promise.reject(thrown);
      }
      settle(task, settled);
    },
    failed: (task, thrown) => settle(task, Promise.reject(thrown)),
  };
}

// A command's reporter: the throw ends the process, as an unhandled one does,
// now naming the task. The daemon's reporter holds it for every bar instead.
export const rethrowing: ReportThrow = (task, thrown) => {
  throw new Error(`${task} threw`, { cause: thrown });
};

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
// or waits for a loop turn. It holds no state; `timer` and `interval` read the
// timer globals when they are called, so jest's fake timers still drive a
// clock over it. `turn` is `node:timers`' own, which jest's fakes leave alone.
// In src, the eslint config lets only the process world (src/host.ts) import
// it.
export const systemTimers: TimerSource = {
  now: () => Date.now(),
  monotonic: () => performance.now() as Monotonic,
  timer: (ms, fire, options) => {
    const timer = setTimeout(fire, ms);
    if (options?.unref) {
      timer.unref();
    }
    return () => clearTimeout(timer);
  },
  interval: (ms, fire, options) => {
    const timer = setInterval(fire, ms);
    if (options?.unref) {
      timer.unref();
    }
    return () => clearInterval(timer);
  },
  turn: (fire) => {
    const turn = setImmediate(fire);
    return () => clearImmediate(turn);
  },
};

// One implementation of the wait, over `after`, so a held clock drives it.
// Ends as `timers/promises`' sleep does: a signal that aborts it rejects with
// an `AbortError` whose `cause` is the signal's reason.
export function sleep(
  clock: Pick<Timekeeper, "after">,
  task: string,
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
    const cancel = clock.after(task, ms, () => {
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
  task: string,
  ms: number,
): AbortSignal {
  const timeout = new AbortController();
  clock.after(
    task,
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
