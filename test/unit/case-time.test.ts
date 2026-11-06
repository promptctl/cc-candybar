// How a wait in a test is bounded: by its own budget, or by what its case has
// left when that is less, less the room its named failure needs to land before
// Jest's timeout.

import { boundedBy, MARGIN_MS } from "../helpers/case-time";
import { caseClock } from "../helpers/case-clock.cjs";

describe("boundedBy — a wait's budget or its case's time, whichever ends first", () => {
  test("a budget the case has room for is the wait, named by its ms", () => {
    expect(boundedBy(5_000, 30_000)).toEqual({ ms: 5_000, named: "5000ms" });
  });

  test("a budget past the case's time is cut to what the case leaves before Jest's timeout", () => {
    const wait = boundedBy(20_000, 10_000);
    expect(wait.ms).toBe(10_000 - MARGIN_MS);
    expect(wait.named).toBe(`the ${wait.ms}ms its case had left, ${MARGIN_MS}ms short of Jest's timeout`);
  });

  test("a case with no time left gives its wait none, so it fails at once by name", () => {
    expect(boundedBy(5_000, 100).ms).toBe(0);
    expect(boundedBy(5_000, -5_000).ms).toBe(0);
  });

  test("outside a case nothing cuts the budget", () => {
    expect(boundedBy(12_000, Infinity)).toEqual({ ms: 12_000, named: "12000ms" });
  });

  test("an infinite budget is refused, since a timer fires at once on one", () => {
    expect(() => boundedBy(Infinity, 30_000)).toThrow(/finite number of ms/);
    expect(() => boundedBy(Number.NaN, 30_000)).toThrow(/finite number of ms/);
  });
});

describe("caseClock — the time a running hook or test has before Jest fails it", () => {
  const state = { testTimeout: 30_000 };
  const at = (start: number): { clock: ReturnType<typeof caseClock>; set: (t: number) => void } => {
    let t = start;
    return { clock: caseClock(() => t), set: (next) => (t = next) };
  };

  test("no case is running before the first function starts", () => {
    expect(at(0).clock.left()).toBe(Infinity);
  });

  test("a test takes the run's timeout unless it names its own", () => {
    const { clock, set } = at(1_000);
    clock.observe({ name: "test_fn_start", test: {} }, state);
    set(4_000);
    expect(clock.left()).toBe(27_000);
    clock.observe({ name: "test_fn_start", test: { timeout: 60_000 } }, state);
    expect(clock.left()).toBe(60_000);
  });

  test("a hook is a case of its own, with its own timeout", () => {
    const { clock } = at(0);
    clock.observe({ name: "hook_start", hook: { timeout: 8_000 } }, state);
    expect(clock.left()).toBe(8_000);
  });

  test("a function's end leaves no case running, whether it passed or failed", () => {
    for (const end of ["hook_success", "hook_failure", "test_fn_success", "test_fn_failure"]) {
      const { clock } = at(0);
      clock.observe({ name: "test_fn_start", test: {} }, state);
      clock.observe({ name: end }, state);
      expect(clock.left()).toBe(Infinity);
    }
  });

  test("a test whose before-hook failed, so its function never ran, leaves no case running once it is done", () => {
    const { clock } = at(0);
    clock.observe({ name: "test_fn_start", test: {} }, state);
    clock.observe({ name: "test_done" }, state);
    expect(clock.left()).toBe(Infinity);
  });

  test("an event that starts and ends nothing leaves the case's time alone", () => {
    const { clock } = at(0);
    clock.observe({ name: "test_fn_start", test: {} }, state);
    clock.observe({ name: "error_handled" }, state);
    expect(clock.left()).toBe(30_000);
  });
});
