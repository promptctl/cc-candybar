// The run outside the process tier, which needs no build. The pattern is config
// and not `--testPathIgnorePatterns`, whose array form swallows a positional
// path and runs everything but the file asked for.

import base, { TEST_MATCH, reportersFor } from "./jest.config.js";
import { PROCESS_TIER_DIR, UNIT_DIR, ignoring } from "./test/helpers/tiers.cjs";

export default {
  ...base,
  testMatch: TEST_MATCH,
  reporters: reportersFor("worker"),
  testPathIgnorePatterns: [PROCESS_TIER_DIR, UNIT_DIR].map(ignoring),
};
