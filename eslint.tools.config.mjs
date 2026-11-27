// Outside-Jest tools and shared libraries follow the same import boundary as
// src. Their JavaScript globals belong to the environment that executes them.
import tsparser from "@typescript-eslint/parser";
import globals from "globals";

import { zonesPlugin } from "./eslint.config.mjs";
import { BROWSER_FILES, JS_GLOB, TOOL_FILES } from "./scripts/import-zones.mjs";

export default [
  {
    files: TOOL_FILES,
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { zones: zonesPlugin },
    rules: { "zones/import-direction": "error" },
  },
  {
    files: TOOL_FILES.map((pattern) => [pattern, JS_GLOB]),
    ignores: BROWSER_FILES,
    languageOptions: { globals: globals.node },
    rules: { "no-undef": ["error", { typeof: true }] },
  },
  {
    files: BROWSER_FILES.map((pattern) => [pattern, JS_GLOB]),
    languageOptions: { globals: globals.browser },
    rules: { "no-undef": ["error", { typeof: true }] },
  },
];
