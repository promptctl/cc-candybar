// The conversation clock every bar plays off. One clock, so each bar on the page is at the same
// moment of the mock conversation, and one speed that scales it for all of them. [LAW:one-source-of-truth]
// Elapsed conversation time accumulates across speed changes, so changing speed never jumps the frame.
export const TICK_MS = 2000;
export const LOOP_MS = 120_000;
export const SPEEDS = [1, 2, 4, 8];

let speed = $state(1);
let elapsed = 0;
let since = Date.now();

export const clock = {
  get speed() {
    return speed;
  },
  set speed(s: number) {
    elapsed = clock.now();
    since = Date.now();
    speed = s;
  },
  // milliseconds into the conversation, wrapped to its loop
  now: () => (elapsed + (Date.now() - since) * speed) % LOOP_MS,
};
