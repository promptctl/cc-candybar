// The process tier alone, the half of the suite that needs a build. With
// `pnpm test:worker` it is all of `pnpm test`, and CI runs the two around its
// build step.

import base, { reportersFor } from "./jest.config.js";
import { PROCESS_TIER_PATTERN } from "./test/helpers/process-tier.cjs";

// The base's ignore of test/e2e/ carries over through the spread.
export default {
  ...base,
  reporters: reportersFor("process"),
  testMatch: undefined,
  testRegex: PROCESS_TIER_PATTERN,
};
