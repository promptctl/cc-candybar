// Jest's names as the boundary's tests know them, written out rather than read
// from the rules under test, so a name the rules miss fails a case.

// Packages that are Jest's: its runner and its parts, its assertion library,
// its transforms and add-ons, and its types.
export const JEST_PACKAGES = [
  "jest",
  "jest/package.json",
  "jest-mock",
  "@jest/globals",
  "expect",
  "ts-jest",
  "babel-jest",
  "babel-plugin-jest-hoist",
  "@swc/jest",
  "@testing-library/jest-dom",
  "@types/jest",
];

// Packages whose names only look like Jest's.
export const NOT_JEST_PACKAGES = [
  "expect-type",
  "jester",
  "mobx",
  "@types/node",
];

// What a test's environment installs: Jest's globals, and the suite's own
// fixture hook (test/helpers/quarantine-environment.cjs).
export const JEST_RUNTIME_GLOBALS = [
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
  "test",
  "xdescribe",
  "xit",
  "xtest",
  "releaseTestFixture",
];

// Every name code outside Jest must not read: the runtime's, and the ones
// Jest's types declare beside them.
export const JEST_GLOBALS = [
  ...JEST_RUNTIME_GLOBALS,
  "fail",
  "pending",
  "spyOn",
];
