// Run only by test/integration/quarantine-gate. The case that fails is listed, and
// forgiven; the afterAll that throws belongs to no case, so it still fails the run.

describe("after all", () => {
  test("a case that fails", () => {
    throw new Error("the listed case failed");
  });

  afterAll(() => {
    throw new Error("the afterAll failed");
  });
});
