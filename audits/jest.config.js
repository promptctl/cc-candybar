// The nightly colour audits' runner: the test suite's jest config over
// audits/ instead of test/, with the hours these walks need.
//
// [LAW:single-enforcer] The rule audits/README.md states, enforced in the one
// place every audit run passes through: `schedule` is the only event name
// GitHub gives a cron run, so it is the only one admitted here.
// [LAW:no-silent-failure] Any other caller fails here, loudly, before a
// single test is collected.

import base from "../jest.config.js";

if (process.env.GITHUB_EVENT_NAME !== "schedule") {
  throw new Error(
    `the colour audits run on GitHub's nightly schedule only, not under "${process.env.GITHUB_EVENT_NAME ?? "no event"}" — audits/README.md`,
  );
}

export default {
  ...base,
  rootDir: "..",
  roots: ["<rootDir>/audits"],
  testMatch: ["**/*.audit.ts"],
  // One test is one walk of the registry under a depth and style, which
  // is minutes, never tens of them: a test that overruns this is hung, and
  // failing it names it, where the job's own limit would name nothing.
  testTimeout: 10 * 60 * 1000,
};
