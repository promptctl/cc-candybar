// The process tier alone, the half of the suite that needs a build. With
// `pnpm test:unit` and `pnpm test:worker` it is all of `pnpm test`, and CI runs
// the three around its build step.

import base, { TEST_MATCH, reportersFor } from "./jest.config.js";
import { PROCESS_TIER_DIR } from "./test/helpers/tiers.cjs";

export default {
  ...base,
  testMatch: TEST_MATCH,
  reporters: reportersFor("process"),
  roots: [`<rootDir>/${PROCESS_TIER_DIR}`],
};
