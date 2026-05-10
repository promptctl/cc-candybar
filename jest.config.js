export default {
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^rich-js$": "<rootDir>/node_modules/rich-js/dist/index.js",
    "^rich-js/themes/data$": "<rootDir>/node_modules/rich-js/dist/themes/data/index.js",
    "^rich-js/template-bindings$": "<rootDir>/node_modules/rich-js/dist/template-bindings/index.js",
    "^@promptctl/go-template-js$": "<rootDir>/node_modules/@promptctl/go-template-js/dist/index.js",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transformIgnorePatterns: [
    // pnpm reroutes file: deps through node_modules/.pnpm/<spec>/node_modules/<pkg>,
    // so the same set of ESM packages must be allow-listed under both the
    // direct path and the .pnpm/ shadow.
    // Scoped packages (@scope/name) are encoded as @scope+name in the pnpm
    // shadow directory prefix — [/+] covers both the direct and shadow forms.
    "node_modules/(?!(\\.pnpm/)?(rich-js|@promptctl[/+]go-template-js|@promptctl[/+]rich-js|@noble[/+]hashes|string-width|strip-ansi|ansi-regex|emoji-regex|get-east-asian-width|eastasianwidth)(@|/))",
  ],
  transform: {
    "^.+\\.(t|j)sx?$": [
      "ts-jest",
      {
        useESM: true,
      },
    ],
  },
  testTimeout: 30000,
};