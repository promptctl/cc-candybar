import { assertTimes, assertionsPerTest } from "./limit";

test("makes one assertion more than allowed", assertTimes(assertionsPerTest + 1));
