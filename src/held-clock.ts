import type { Monotonic, Timekeeper } from "./time.js";

// A clock moved by hand. Both of its readings and every timer it hands out
// stand still until `advance`, so a replay runs at whatever pace its driver
// sets (the demo's `--recording`), and a test's daemon on it has its clients
// state their deadlines on it: a request's budget is that deadline less this
// clock's arrival.
export interface HeldClock extends Timekeeper {
  // Moves time forward, running each timer that falls due at its own moment,
  // one due exactly at the end included. A timer already due, and a deferred
  // run, wait for it too: `advance(0)` runs them. A callback that burns time
  // carries the clock past the end asked for. Nothing here takes a turn of the
  // real loop, so a case decides when.
  advance(ms: number): void;
  // Time a synchronous piece of work uses: moves time forward without firing
  // any timer, so what fell due while it ran waits for the next `advance`, as
  // it waits for the loop in a real process. A timer due during the burn runs
  // at the burned moment, late, as a real one does; a repeating one runs once,
  // not once per period it missed.
  burn(ms: number): void;
  // How many timers are armed: a cancelled or fired one-shot is not.
  pending(): number;
}

// `start` is the wall time it stands at.
export function heldClock(start: Date): HeldClock {
  let elapsed = 0;
  // A repeating timer keeps its record and re-arms a period from where it fired,
  // as an interval does after a blocked loop: one late run, not one per missed
  // period. A one-shot leaves the set.
  const timers = new Set<{ at: number; fire: () => void; period?: number }>();
  const nextDue = (end: number) =>
    [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
  // Each timer fires at its own moment, and one cleared by an earlier firing
  // does not fire at all.
  const fireThrough = (end: number): void => {
    for (let due = nextDue(end); due; due = nextDue(end)) {
      // Time never runs back: a burn may have passed the moment this was set for.
      elapsed = Math.max(elapsed, due.at);
      if (due.period === undefined) {
        timers.delete(due);
      } else {
        due.at = elapsed + due.period;
      }
      due.fire();
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
  return {
    // Whole milliseconds, as `Date.now()` reads them.
    now: () => Math.trunc(start.getTime() + elapsed),
    monotonic: () => elapsed as Monotonic,
    // A boot stands still while the clock moves on, and the machine a held
    // clock stands for booted before any wall time a case can set it to.
    bootTime: () => -Infinity,
    after: (ms, fire) => arm(ms, fire),
    every: (ms, fire) => arm(Math.max(1, ms), fire, Math.max(1, ms)),
    defer: (fire) => arm(0, fire),
    advance: (ms) => fireThrough(elapsed + span(ms)),
    burn: (ms) => {
      elapsed += span(ms);
    },
    pending: () => timers.size,
  };
}
