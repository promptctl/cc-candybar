// Run only by test/integration/quarantine-gate. The listed case passes and leaves a
// timer that throws once it has ended. The error belongs to whichever case is
// running then, which is the next one and is not listed, so it fails the run.

test("a case that leaves a timer", () => {
  setTimeout(() => {
    throw new Error("the timer threw late");
  }, 20);
});

test("the case running when it throws", async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
});
