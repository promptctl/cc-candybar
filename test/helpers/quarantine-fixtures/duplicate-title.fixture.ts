// Run only by test/integration/quarantine-gate. One line lists "a title used twice",
// and two cases carry it, so the line names no single case: the file errors and
// neither failure is let through.

test("a title used twice", () => {
  throw new Error("the first failed");
});

test("a title used twice", () => {
  throw new Error("the second failed");
});
