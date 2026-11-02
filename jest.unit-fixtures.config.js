// The unit config over the fixtures that prove its refusal
// (test/helpers/unit-refusal-fixtures, run by test/integration/unit-refusal). It
// goes through the real unit config, so every refusal the real run has is on. No
// records: these files are not part of any run.

import unit from "./jest.unit.config.js";

export default {
  ...unit,
  roots: ["<rootDir>/test/helpers/unit-refusal-fixtures"],
  testMatch: ["**/*.fixture.ts"],
  reporters: ["default"],
};
