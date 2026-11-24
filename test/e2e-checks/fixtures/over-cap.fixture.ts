import { assertTimes, assertionsPerTest, cap } from "./limit";

// One test more than the sign-off allows, each within the assertion limit: the
// run must fail on the cap alone.
for (let i = 0; i <= cap; i += 1) {
  test(`over the cap, test ${i + 1} of ${cap + 1}`, assertTimes(assertionsPerTest));
}
