// The run outside the process tier, which needs no build. The pattern is config
// and not `--testPathIgnorePatterns`, whose array form swallows a positional
// path and runs everything but the file asked for.

import base from "./jest.config.js";
import { PROCESS_TIER_PATTERN } from "./test/helpers/process-tier.cjs";

export default {
  ...base,
  testPathIgnorePatterns: [PROCESS_TIER_PATTERN],
};
