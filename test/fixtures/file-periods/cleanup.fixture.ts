test("one refused cleanup still waits for its peers", () => {
  const handle = setInterval(function releasedByFixture() {}, 60000);
  releaseTestFixture(async () => {
    throw new Error("fixture release refused");
  });
  releaseTestFixture(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    clearInterval(handle);
  });
});
