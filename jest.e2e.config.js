// The end-to-end run: the base config plus the two checks that hold the
// sign-off's cap and assertion limit (test/e2e-checks/). `roots` stays the
// base's `test`, because git cannot hold the empty test/e2e/ and jest rejects a
// root that does not exist.

import base, { reportersFor } from "./jest.config.js";
import { ASSERTION_LIMIT_SETUP, CAP_REPORTER } from "./test/e2e-checks/wiring.cjs";

export function e2eConfig({ run, roots = base.roots, testMatch }) {
  return {
    ...base,
    roots,
    testMatch,
    // The base ignores test/e2e/; this is the one run meant to pick it up.
    testPathIgnorePatterns: [],
    reporters: [...reportersFor(run), CAP_REPORTER],
    setupFilesAfterEnv: [...base.setupFilesAfterEnv, ASSERTION_LIMIT_SETUP],
  };
}

export default e2eConfig({ run: "e2e", testMatch: ["<rootDir>/test/e2e/**/*.test.ts"] });
