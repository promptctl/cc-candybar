// The case's time as the test environment keeps it, read by a real wait in a
// real case: a wait whose budget outlasts its case fails by its own name before
// Jest's timeout, which would name nothing.

import { restOfCase, within } from "./helpers/case-time";
import { until } from "./helpers/until";

const CASE_TIMEOUT_MS = 5_000;

describe("a case's time bounds the waits inside it", () => {
  let leftInHook = Infinity;
  beforeAll(() => {
    leftInHook = restOfCase();
  }, 8_000);

  test("a hook's time is its own timeout", () => {
    expect(leftInHook).toBeLessThanOrEqual(8_000);
    expect(leftInHook).toBeGreaterThan(7_000);
  });

  test("a test's time is the timeout it was given", () => {
    const left = restOfCase();
    expect(left).toBeLessThanOrEqual(CASE_TIMEOUT_MS);
    expect(left).toBeGreaterThan(CASE_TIMEOUT_MS - 1_000);
  }, CASE_TIMEOUT_MS);

  test(
    "a wait longer than its case fails by its own name, inside the case",
    async () => {
      await expect(until(() => false, "a condition that never holds", 60_000)).rejects.toThrow(
        /^a condition that never holds did not hold within the \d+ms its case had left$/,
      );
    },
    CASE_TIMEOUT_MS,
  );

  test("the case's time reads true while the test fakes the clock", () => {
    jest.useFakeTimers({ now: 0 });
    try {
      expect(within(60_000).ms).toBeGreaterThan(0);
      expect(within(60_000).ms).toBeLessThan(CASE_TIMEOUT_MS);
    } finally {
      jest.useRealTimers();
    }
  }, CASE_TIMEOUT_MS);
});

// Read at collection, when no hook or test function has started.
const noCaseError = ((): string => {
  try {
    restOfCase();
    return "restOfCase answered outside a case";
  } catch (e) {
    return (e as Error).message;
  }
})();

test("between cases no case is running, so the rest of one is refused", () => {
  expect(noCaseError).toMatch(/no Jest case is running/);
});
