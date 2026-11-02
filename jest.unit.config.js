// The unit run: test/unit only, with the refusal installed (test/unit-setup.ts),
// so a file here has passed it and the unit count is always true. A unit test
// touches nothing shared, so the run takes every core where the booting tiers
// keep the base's cap of 4, which is global to a run and so cannot be per-tier.

import base, { TEST_MATCH, reportersFor } from "./jest.config.js";
import { UNIT_DIR } from "./test/helpers/tiers.cjs";

export default {
  ...base,
  roots: [`<rootDir>/${UNIT_DIR}`],
  testMatch: TEST_MATCH,
  maxWorkers: "100%",
  reporters: reportersFor("unit"),
  setupFilesAfterEnv: [...base.setupFilesAfterEnv, "<rootDir>/test/unit-setup.ts"],
};
