// The tools a developer runs by hand (scripts/, proto-looks/) and the site's
// page code (site/) run outside Jest. They are checked for one thing: the direction of
// their imports, by the zone rule src is checked by, so none reaches into the
// test suite. [LAW:one-way-deps] [LAW:single-enforcer]
import tsparser from "@typescript-eslint/parser";

import { zonesPlugin } from "./eslint.config.mjs";

// What only Jest provides. A tool that read one would run under Jest alone.
const JEST_GLOBALS = [
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "expect",
  "it",
  "jest",
  "releaseTestFixture",
  "test",
].map((name) => ({
  name,
  message: `${name} is Jest's, and this code runs outside Jest. [LAW:one-way-deps]`,
}));

export default [
  {
    files: ["scripts/**/*.{ts,mts,js,mjs,cjs}", "site/**/*.{ts,mts,js,mjs}", "proto-looks/**/*.{ts,mjs}"],
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { zones: zonesPlugin },
    rules: {
      "zones/import-direction": "error",
      "no-restricted-globals": ["error", ...JEST_GLOBALS],
    },
  },
];
