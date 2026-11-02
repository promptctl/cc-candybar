// Run only by test/integration/quarantine-gate, through jest.quarantine-fixtures.config.js.
// The case that fails is on the fixtures' list; the one beside it is not and passes.

describe("listed", () => {
  test("a case that fails", () => {
    throw new Error("the listed case failed");
  });

  test("a case that passes", () => {});
});
