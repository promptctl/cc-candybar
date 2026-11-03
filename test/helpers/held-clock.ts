import fs from "node:fs";
import type { Timekeeper } from "../../src/time";

// A clock a test moves by hand. Both of its readings and every timer it hands
// out stand still until `advance`, so it belongs on a daemon its case owns,
// whose clients state their deadlines on it: a request's budget is that deadline
// less this clock's arrival.
export interface HeldClock extends Timekeeper {
  // Moves time forward, running each timer that falls due at its own moment. A
  // timer already due, and a deferred run, wait for it too: `advance(0)` runs
  // them. Nothing here takes a turn of the real loop, so a case decides when.
  advance(ms: number): void;
  // Time a synchronous piece of work uses: moves time forward without firing
  // any timer, so what fell due while it ran waits for the next `advance`, as
  // it waits for the loop in a real process. A timer due during the burn runs
  // at the burned moment, late, as a real one does.
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
export function heldClock(start: Date): HeldClock {
  let elapsed = 0;
  // A repeating timer keeps its record and moves `at` by its period each time it
  // fires; a one-shot leaves the set.
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
        due.at += due.period;
      }
      due.fire();
    }
    elapsed = Math.max(elapsed, end);
  };
  const arm = (ms: number, fire: () => void, period?: number) => {
    const timer = { at: elapsed + ms, fire, period };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  return {
    // Whole milliseconds, as `Date.now()` reads them.
    now: () => Math.trunc(start.getTime() + elapsed),
    monotonic: () => elapsed,
    after: (ms, fire) => arm(ms, fire),
    every: (ms, fire) => arm(Math.max(1, ms), fire, Math.max(1, ms)),
    defer: (fire) => arm(0, fire),
    advance: (ms) => fireThrough(elapsed + ms),
    burn: (ms) => {
      elapsed += ms;
    },
    pending: () => timers.size,
    pinMtime: (file) => {
      const at = new Date(start.getTime() + elapsed);
      fs.utimesSync(file, at, at);
    },
  };
}
