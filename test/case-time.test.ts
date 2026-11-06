// The case's time as the test environment keeps it, read by a real wait in a
// real case: a wait whose budget outlasts its case fails by its own name before
// Jest's timeout, which would name nothing.

import { MARGIN_MS, restOfCase, within } from "./helpers/case-time";
import { until } from "./helpers/until";

const CASE_TIMEOUT_MS = 5_000;
const HOOK_TIMEOUT_MS = 8_000;

// The rest of a case is a bound that ends the margin short of Jest's timeout.
describe("a case's time bounds the waits inside it", () => {
  let restInHook = Infinity;
  beforeAll(() => {
    restInHook = restOfCase().ms;
  }, HOOK_TIMEOUT_MS);

  test("a hook's time is its own timeout", () => {
    expect(restInHook).toBeLessThanOrEqual(HOOK_TIMEOUT_MS - MARGIN_MS);
    expect(restInHook).toBeGreaterThan(HOOK_TIMEOUT_MS - MARGIN_MS - 1_000);
  });

  test("a test's time is the timeout it was given", () => {
    const rest = restOfCase();
    expect(rest.ms).toBeLessThanOrEqual(CASE_TIMEOUT_MS - MARGIN_MS);
    expect(rest.ms).toBeGreaterThan(CASE_TIMEOUT_MS - MARGIN_MS - 1_000);
    expect(rest.named).toBe(`the ${rest.ms}ms its case had left, ${MARGIN_MS}ms short of Jest's timeout`);
  }, CASE_TIMEOUT_MS);

  test(
    "a wait longer than its case fails by its own name, inside the case",
    async () => {
      await expect(until(() => false, "a condition that never holds", 60_000)).rejects.toThrow(
        /^a condition that never holds did not hold within the \d+ms its case had left, \d+ms short of Jest's timeout$/,
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
