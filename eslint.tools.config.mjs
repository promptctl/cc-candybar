// The tools a developer runs by hand (scripts/, proto-looks/), the code they
// share with the tests (scripts/lib/) and the site's page code (site/) run
// outside Jest. They are held to that: their imports follow the zone rule src is
// checked by, so none reaches into the test suite or Jest's packages, and none
// reads a global only Jest provides. [LAW:one-way-deps] [LAW:single-enforcer]
import tsparser from "@typescript-eslint/parser";
import globals from "globals";

import { zonesPlugin } from "./eslint.config.mjs";
import { CODE_GLOB, OUTSIDE_JEST_ROOTS } from "./scripts/import-zones.mjs";

export default [
  // Run over the repo, it lints those roots and nothing else.
  { ignores: ["*", ...OUTSIDE_JEST_ROOTS.map((root) => `!${root}`)] },
  {
    files: OUTSIDE_JEST_ROOTS.map((root) => `${root}${CODE_GLOB}`),
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { zones: zonesPlugin },
    rules: { "zones/import-direction": "error" },
  },
  // [LAW:one-way-deps] A tool's environment is closed: its TypeScript is
  // type-checked with Node's types alone, and its JavaScript reads only what
  // Node provides (and the browser, for the page `pnpm bar:web` serves), so a
  // name only Jest installs is undefined, `typeof` included.
  {
    files: OUTSIDE_JEST_ROOTS.map((root) => `${root}**/*.{js,mjs,cjs}`),
    languageOptions: { globals: globals.node },
    rules: { "no-undef": ["error", { typeof: true }] },
  },
  {
    files: ["scripts/bar-web/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
];
