import { assertTimes, assertionsPerTest } from "./limit";

// The control of the assertion limit: a test at it must pass.
test("makes exactly the allowed assertions", assertTimes(assertionsPerTest));
