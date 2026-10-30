// Timing in-process work: warm up, then time each repetition on its own.
//
// Every repetition is timed separately because the tail is the result. A loop
// timed as a whole reports its mean and loses the one repetition that stalled.

export const WARMUP = 3;

// Repetitions of `body`, `WARMUP` unrecorded first so the JIT and the module
// graph are warm. `body` gets the repetition's index (warmups count from
// negative), because a repetition that must differ from the last (the next
// second of a clock, the next file) is data, not state kept beside the loop.
export async function repeat(
  count: number,
  body: (index: number) => void | Promise<void>,
  // Run before each repetition, outside its timing: the change the repetition
  // measures the reaction to.
  setup?: (index: number) => void | Promise<void>,
): Promise<number[]> {
  const ms: number[] = [];
  for (let i = -WARMUP; i < count; i++) {
    await setup?.(i);
    const started = performance.now();
    await body(i);
    const took = performance.now() - started;
    if (i >= 0) ms.push(took);
  }
  return ms;
}

// One run of `body`, its result and how long it took.
export async function timed<T>(
  body: () => T | Promise<T>,
): Promise<{ readonly ms: number; readonly value: T }> {
  const started = performance.now();
  const value = await body();
  return { ms: performance.now() - started, value };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
