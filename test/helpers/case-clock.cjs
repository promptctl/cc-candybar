// [LAW:single-enforcer] How long the running case has left before Jest fails it
// with its own timeout. The test environment is the one writer: it sees each
// hook and test function start and end, and computes the deadline from the
// same expression jest-circus arms its timer with, just before circus arms it.
// A helper's wait reads it through the function the environment publishes on
// the sandbox's global (test/helpers/case-time.ts), so no wait need know how
// many others the case has already spent.
//
// The function closes over the environment's own clock, not the sandbox's: a
// test that fakes the sandbox's Date still reads its case's real time here.
//
// CommonJS because jest loads an environment untransformed.

const CASE_TIME_LEFT = Symbol.for("cc-candybar.caseTimeLeft");

const STARTS = new Set(["hook_start", "test_fn_start"]);
const ENDS = new Set([
  "hook_success",
  "hook_failure",
  "test_fn_success",
  "test_fn_failure",
]);

/**
 * Between functions no case is running, so none has a deadline.
 * @param {() => number} now
 */
function caseClock(now) {
  let deadline = Infinity;
  return {
    /** @param {{ name: string, hook?: { timeout?: number }, test?: { timeout?: number } }} event */
    observe(event, state) {
      if (STARTS.has(event.name)) {
        deadline = now() + ((event.hook ?? event.test).timeout || state.testTimeout);
      } else if (ENDS.has(event.name)) {
        deadline = Infinity;
      }
    },
    left: () => deadline - now(),
  };
}

module.exports = { CASE_TIME_LEFT, caseClock };
