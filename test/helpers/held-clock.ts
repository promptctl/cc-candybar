import fs from "node:fs";
import {
  clockOver,
  rethrowing,
  type Monotonic,
  type Timekeeper,
  type TimerSource,
} from "../../src/time";

// A clock a test moves by hand. Both of its readings and every timer it hands
// out stand still until `advance`, so it belongs on a daemon its case owns,
// whose clients state their deadlines on it: a request's budget is that deadline
// less this clock's arrival.
export interface HeldClock extends Timekeeper {
  // Moves time forward, running each timer that falls due at its own moment,
  // one due exactly at the end included. A timer already due, and a deferred
  // run queued before the call, wait for it too: `advance(0)` runs them. A run
  // deferred from inside the call waits for the next one, as it waits for the
  // loop's next turn on the machine, so what the case does between two calls
  // (a frame written to a stream) lands ahead of it. A callback that burns time
  // carries the clock past the end asked for. Nothing here takes a turn of the
  // real loop, so a case decides when.
  advance(ms: number): void;
  // `advance` for work a timer starts that awaits: after each timer fires,
  // what it queued settles before the next due one is sought, so a draw that
  // awaits its frame lands, and arms what follows, inside the span, as on a
  // real loop. A run it deferred waits for the turn after that.
  settle(ms: number): Promise<void>;
  // Time a synchronous piece of work uses: moves time forward without firing
  // any timer, so what fell due while it ran waits for the next `advance`, as
  // it waits for the loop in a real process. A timer due during the burn runs
  // at the burned moment, late, as a real one does; a repeating one runs once,
  // not once per period it missed.
  burn(ms: number): void;
  // How many timers are armed: a cancelled or fired one-shot is not.
  pending(): number;
  // Puts a file's modification time at this clock's reading, so a check that
  // ages the file against `now` reads one clock, not two.
  pinMtime(file: string): void;
}

// `start` is the wall time it stands at. A test with no reason to pick one names
// the real now itself (`new Date()`), so the choice is in the test and the unit
// project, which refuses the real clock, can still build one.
// Its clock is built over its timers as `over` builds one: a case that
// expects no throw lets it throw (`rethrowing`), and a daemon's case builds
// the daemon's (`reportingClock`), so its throws reach the bar.
export function heldClock(start: Date): HeldClock;
export function heldClock<C extends Timekeeper>(
  start: Date,
  over: (source: TimerSource) => C,
): HeldClock & C;
export function heldClock(
  start: Date,
  over: (source: TimerSource) => Timekeeper = (source) =>
    clockOver(source, rethrowing),
): HeldClock {
  let elapsed = 0;
  // A repeating timer keeps its record and re-arms a period from where it fired,
  // as an interval does after a blocked loop: one late run, not one per missed
  // period. A one-shot leaves the set.
  const timers = new Set<{ at: number; fire: () => void; period?: number }>();
  const nextDue = (end: number) =>
    [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
  // Each timer fires at its own moment, and one cleared by an earlier firing
  // does not fire at all.
  const fire = (due: { at: number; fire: () => void; period?: number }) => {
    // Time never runs back: a burn may have passed the moment this was set for.
    elapsed = Math.max(elapsed, due.at);
    if (due.period === undefined) {
      timers.delete(due);
    } else {
      due.at = elapsed + due.period;
    }
    due.fire();
  };
  // [LAW:no-ambient-temporal-coupling] A deferred run is the loop's next turn,
  // which comes after the timers due now and the input already waiting, so one
  // queued while a timer runs is not in the set a call takes first. One cleared
  // by an earlier run in the set does not run.
  const turns = new Set<() => void>();
  const runTurns = (queued: readonly (() => void)[]): void => {
    for (const turn of queued) if (turns.delete(turn)) turn();
  };
  const fireThrough = (end: number): void => {
    const queued = [...turns];
    for (let due = nextDue(end); due; due = nextDue(end)) fire(due);
    elapsed = Math.max(elapsed, end);
    runTurns(queued);
  };
  // The real loop's next check phase, which runs once every queued microtask
  // has: the held clock arms no real timer, so this is the case's only wait.
  const queuedSettled = () =>
    new Promise<void>((resolve) => setImmediate(resolve));
  const settleThrough = async (end: number): Promise<void> => {
    await queuedSettled();
    for (;;) {
      const queued = [...turns];
      const due = nextDue(end);
      if (!due && queued.length === 0) break;
      if (due) fire(due);
      runTurns(queued);
      await queuedSettled();
    }
    elapsed = Math.max(elapsed, end);
  };
  // [LAW:single-enforcer] Time only moves forward by a number: a negative or
  // NaN span would leave every later comparison false and every timer silent.
  const span = (ms: number): number => {
    if (!(ms >= 0 && Number.isFinite(ms))) {
      throw new RangeError(
        `a held clock moves by a finite span of 0 or more, got ${ms}`,
      );
    }
    return ms;
  };
  const arm = (ms: number, fire: () => void, period?: number) => {
    const timer = { at: elapsed + ms, fire, period };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  // [LAW:single-enforcer] A source like the machine's, so the clock a case
  // holds is built as the process's is, and reports through the same guard.
  const source: TimerSource = {
    // Whole milliseconds, as `Date.now()` reads them.
    now: () => Math.trunc(start.getTime() + elapsed),
    monotonic: () => elapsed as Monotonic,
    timer: (ms, fire) => arm(ms, fire),
    interval: (ms, fire) => arm(Math.max(1, ms), fire, Math.max(1, ms)),
    turn: (fire) => {
      turns.add(fire);
      return () => turns.delete(fire);
    },
  };
  return {
    ...over(source),
    advance: (ms) => fireThrough(elapsed + span(ms)),
    settle: (ms) => settleThrough(elapsed + span(ms)),
    burn: (ms) => {
      elapsed += span(ms);
    },
    pending: () => timers.size,
    pinMtime: (file) => {
      const at = new Date(start.getTime() + elapsed);
      fs.utimesSync(file, at, at);
    },
  };
}
