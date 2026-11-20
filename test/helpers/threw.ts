import {
  threwLine,
  type ThrewSink,
} from "../../src/daemon/foundations/verb-error.js";

// A test's failure sink: a delivery or discovery that threw fails the test
// where it is reported, rather than passing quietly.
export const failTest: ThrewSink = (...threw) => {
  throw new Error(threwLine(...threw));
};
