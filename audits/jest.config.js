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
    "the colour audits run on the nightly GitHub schedule only (.github/workflows/colour-audits.yml); " +
      "they are never run locally, on a PR, on main, or by hand — see audits/README.md",
  );
}

export default {
  ...base,
  rootDir: "..",
  roots: ["<rootDir>/audits"],
  testMatch: ["**/*.audit.ts"],
  // One file is one walk of the whole registry; decor-registry alone is
  // minutes per test.each row.
  testTimeout: 60 * 60 * 1000,
};
