// The base config over the fixtures that prove the quarantine moves the gate
// (test/helpers/quarantine-fixtures, run by test/integration/quarantine-gate).
// It goes through the real base, so the same environment is on, and the list it
// reads is the fixtures' own. The reporters are the real ones a run has, minus
// the records: these files are not part of any run, and a reporter that
// misreads what the quarantine leaves in a result shows in the output.

import base from "./jest.config.js";

export default {
  ...base,
  roots: ["<rootDir>/test/helpers/quarantine-fixtures"],
  testMatch: ["**/*.fixture.ts"],
  reporters: ["default", "<rootDir>/test/stackless-failure-reporter.mjs"],
  testEnvironmentOptions: { quarantine: "test/helpers/quarantine-fixtures/quarantine.txt" },
};
