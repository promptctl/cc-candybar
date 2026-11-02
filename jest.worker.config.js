// The run outside the process tier, which needs no build. The pattern is config
// and not `--testPathIgnorePatterns`, whose array form swallows a positional
// path and runs everything but the file asked for.

import base, { E2E_DIR_PATTERN, reportersFor } from "./jest.config.js";
import { PROCESS_TIER_PATTERN } from "./test/helpers/process-tier.cjs";

export default {
  ...base,
  reporters: reportersFor("worker"),
  testPathIgnorePatterns: [PROCESS_TIER_PATTERN, E2E_DIR_PATTERN],
};
