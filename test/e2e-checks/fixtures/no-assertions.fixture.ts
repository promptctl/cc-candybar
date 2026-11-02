// A test that only waits makes no assertion, and the limit requires exactly the
// allowed number, so it must fail.
test("waits and asserts nothing", async () => {
  await Promise.resolve();
});
