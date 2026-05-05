export default {
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^rich-js$": "<rootDir>/node_modules/rich-js/dist/index.js",
    "^rich-js/themes/data$": "<rootDir>/node_modules/rich-js/dist/themes/data/index.js",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transformIgnorePatterns: [
    // pnpm reroutes file: deps through node_modules/.pnpm/<spec>/node_modules/<pkg>,
    // so the same set of ESM packages must be allow-listed under both the
    // direct path and the .pnpm/ shadow.
    "node_modules/(?!(\\.pnpm/)?(rich-js|string-width|strip-ansi|ansi-regex|emoji-regex|get-east-asian-width|eastasianwidth)(@|/))",
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