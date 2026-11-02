import { readSignoff } from "../signoff.cjs";

// What the fixtures measure themselves against: the sign-off's own numbers, so
// raising either in the sign-off cannot turn a fixture that should fail into one
// that passes.
export const { cap, assertionsPerTest } = readSignoff();

/** A test body that makes exactly `count` assertions. */
export function assertTimes(count: number): () => void {
  return () => {
    for (let i = 0; i < count; i += 1) expect(i).toBe(i);
  };
}
