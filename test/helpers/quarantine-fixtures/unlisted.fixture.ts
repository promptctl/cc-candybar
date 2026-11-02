// Run only by test/integration/quarantine-gate. This file's failing case is not on
// the fixtures' list, so it has to fail its run.

test("an unlisted case that fails", () => {
  throw new Error("the unlisted case failed");
});
