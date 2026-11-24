// The tools a developer runs by hand (scripts/, proto-looks/), the code they
// share with the tests (scripts/lib/) and the site's page code (site/) run
// outside Jest. They are held to that: their imports follow the zone rule src is
// checked by, so none reaches into the test suite, and none imports Jest or
// reads a global only Jest provides. [LAW:one-way-deps] [LAW:single-enforcer]
import tsparser from "@typescript-eslint/parser";

import { zonesPlugin } from "./eslint.config.mjs";
import { OUTSIDE_JEST_ROOTS } from "./scripts/import-zones.mjs";

const OUTSIDE_JEST = "this code runs outside Jest. [LAW:one-way-deps]";

// What only Jest provides: the globals its environment installs, the suite's
// own fixture hook among them (test/helpers/quarantine-environment.cjs).
const JEST_GLOBALS = [
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "expect",
  "fdescribe",
  "fit",
  "it",
  "jest",
  "releaseTestFixture",
  "test",
  "xdescribe",
  "xit",
  "xtest",
].map((name) => ({ name, message: `${name} is Jest's, and ${OUTSIDE_JEST}` }));

export default [
  // Run over the repo, it lints those roots and nothing else.
  { ignores: ["*", ...OUTSIDE_JEST_ROOTS.map((root) => `!${root}`)] },
  {
    files: OUTSIDE_JEST_ROOTS.map((root) => `${root}**/*.{ts,mts,js,mjs,cjs}`),
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { zones: zonesPlugin },
    rules: {
      "zones/import-direction": "error",
      "no-restricted-globals": ["error", ...JEST_GLOBALS],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["jest", "@jest/*"], message: `Jest is the test suite's, and ${OUTSIDE_JEST}` }] },
      ],
    },
  },
];
