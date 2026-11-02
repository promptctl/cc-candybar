import { assertTimes, assertionsPerTest, cap } from "./limit";

// Exactly the sign-off's cap, each at the assertion limit: the boundary the cap
// check must let through, so a check that fails everything does not pass as one
// that holds the line.
for (let i = 0; i < cap; i += 1) {
  test(`at the cap, test ${i + 1} of ${cap}`, assertTimes(assertionsPerTest));
}
