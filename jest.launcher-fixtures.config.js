// The base config over the fixtures that prove a file's fixture launchers end
// with it (test/helpers/launcher-fixtures, run by
// test/integration/fixture-launchers.test.ts). It goes through the real base,
// so the environment that ends them is the one every run has.

import base from "./jest.config.js";

export default {
  ...base,
  roots: ["<rootDir>/test/helpers/launcher-fixtures"],
  testMatch: ["**/*.fixture.ts"],
  reporters: ["default"],
};
