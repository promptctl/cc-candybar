// [LAW:single-enforcer] The two entries that put the end-to-end checks into a
// jest config, named once so the config that adds them and the test that proves
// the config carries them cannot disagree.

const ASSERTION_LIMIT_SETUP = "<rootDir>/test/e2e-checks/assertion-limit.ts";
const CAP_REPORTER = "<rootDir>/test/e2e-checks/cap-reporter.cjs";

module.exports = { ASSERTION_LIMIT_SETUP, CAP_REPORTER };
