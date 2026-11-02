// The process tier alone, the half of the suite that needs a build. With
// `pnpm test:unit` and `pnpm test:worker` it is all of `pnpm test`, and CI runs
// the three around its build step.

import base, { reportersFor } from "./jest.config.js";
import { PROCESS_TIER_DIR } from "./test/helpers/tiers.cjs";

// The base's ignore of test/e2e/ and test/unit/ carries over through the spread.
export default {
  ...base,
  reporters: reportersFor("process"),
  roots: [`<rootDir>/${PROCESS_TIER_DIR}`],
};
