// The end-to-end config over the fixtures that prove its checks
// (test/e2e-checks/fixtures, run by test/integration/e2e-checks). It goes
// through the real e2eConfig, so every check the real run has is on; each child
// run names its own records through E2E_CHECKS_RUN so parallel runs share no file.

import { e2eConfig } from "./jest.e2e.config.js";

export default e2eConfig({
  run: process.env.E2E_CHECKS_RUN,
  roots: ["<rootDir>/test/e2e-checks/fixtures"],
  testMatch: ["**/*.fixture.ts"],
});
