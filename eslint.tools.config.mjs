// The tools a developer runs by hand (scripts/, proto-looks/), the code they
// share with the tests (scripts/lib/) and the site's page code (site/) run
// outside Jest. They are held to that: their imports follow the zone rule src is
// checked by, so none reaches into the test suite or Jest's packages, and none
// reads a global only Jest provides. [LAW:one-way-deps] [LAW:single-enforcer]
import tsparser from "@typescript-eslint/parser";

import { zonesPlugin } from "./eslint.config.mjs";
import { JEST_GLOBALS, OUTSIDE_JEST_ROOTS } from "./scripts/import-zones.mjs";

const OUTSIDE_JEST = "this code runs outside Jest. [LAW:one-way-deps]";

const REFUSED_GLOBALS = JEST_GLOBALS.map((name) => ({ name, message: `${name} is Jest's, and ${OUTSIDE_JEST}` }));

export default [
  // Run over the repo, it lints those roots and nothing else.
  { ignores: ["*", ...OUTSIDE_JEST_ROOTS.map((root) => `!${root}`)] },
  {
    files: OUTSIDE_JEST_ROOTS.map((root) => `${root}**/*.{ts,mts,js,mjs,cjs}`),
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { zones: zonesPlugin },
    rules: {
      "zones/import-direction": "error",
      // The tools' JavaScript has no type-check to find these undefined.
      "no-restricted-globals": ["error", ...REFUSED_GLOBALS],
    },
  },
];
