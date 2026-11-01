import path from "node:path";

import { TEST_FILE_ENV } from "./helpers/process-tier.cjs";

// [LAW:single-enforcer] What names a daemon's test file in the ledger. It is here
// and not in test/setup.ts because the file being run is not known until the
// test framework is installed.
process.env[TEST_FILE_ENV] = path.relative(
  process.cwd(),
  expect.getState().testPath!,
);
