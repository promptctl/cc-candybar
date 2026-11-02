// Run only by test/integration/quarantine-gate. The listed case passes and leaves a
// timer that throws once it has ended. The error belongs to whichever case is
// running then, which is the next one and is not listed, so it fails the run.

let thrown: () => void;
const timerRan = new Promise<void>((resolve) => (thrown = resolve));

test("a case that leaves a timer", () => {
  // The timer is far enough out that the next case has begun by then, and it
  // signals from its own finally, so the next case waits on the throw itself
  // rather than on a sleep that a loaded machine can outrun.
  setTimeout(() => {
    try {
      throw new Error("the timer threw late");
    } finally {
      thrown();
    }
  }, 100);
});

test("the case running when it throws", async () => {
  await timerRan;
  // The throw reaches jest after the finally, so the case stays open past it.
  await new Promise((resolve) => setTimeout(resolve, 50));
});
