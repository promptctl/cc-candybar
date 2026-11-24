// The app (src/), the tools a developer runs by hand (scripts/, proto-looks/),
// the code they share with the tests (scripts/lib/) and the site's page code
// (site/) run outside Jest. They are held to that: none reads a global only Jest
// provides, and the tools' imports follow the zone rule src is checked by, so
// none reaches into the test suite or Jest's packages. [LAW:one-way-deps]
// [LAW:single-enforcer]
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

import { zonesPlugin } from "./eslint.config.mjs";
import { OUTSIDE_JEST_ROOTS, TOOL_ROOTS } from "./scripts/import-zones.mjs";

const OUTSIDE_JEST = "this code runs outside Jest. [LAW:one-way-deps]";
const APP_ROOTS = OUTSIDE_JEST_ROOTS.filter((root) => !TOOL_ROOTS.includes(root));
const sourcesUnder = (roots) => roots.map((root) => `${root}**/*.{ts,mts,js,mjs,cjs}`);

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
    files: sourcesUnder(OUTSIDE_JEST_ROOTS),
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-restricted-globals": ["error", ...JEST_GLOBALS],
    },
  },
  // The app's directives belong to src's own config, which runs the rules they
  // name and reports the ones left unused. Here the plugin is loaded for its
  // rule names only, and turns none of them on.
  {
    files: sourcesUnder(APP_ROOTS),
    plugins: { "@typescript-eslint": tseslint },
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: sourcesUnder(TOOL_ROOTS),
    plugins: { zones: zonesPlugin },
    rules: { "zones/import-direction": "error" },
  },
];
