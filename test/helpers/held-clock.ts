import fs from "node:fs";
import {
  heldClock as productHeldClock,
  type HeldClock as ProductHeldClock,
} from "../../src/held-clock";

// The product's held clock (src/held-clock.ts), with what only a test does
// beside one: a file written next to it carries the real clock's mtime.
export interface HeldClock extends ProductHeldClock {
  // Puts a file's modification time at this clock's reading, so a check that
  // ages the file against `now` reads one clock, not two.
  pinMtime(file: string): void;
}

// A test with no reason to pick a start names the real now itself
// (`new Date()`), so the choice is in the test and the unit project, which
// refuses the real clock, can still build one.
export function heldClock(start: Date): HeldClock {
  const clock = productHeldClock(start);
  return {
    ...clock,
    pinMtime: (file) => {
      const at = new Date(start.getTime() + clock.monotonic());
      fs.utimesSync(file, at, at);
    },
  };
}
