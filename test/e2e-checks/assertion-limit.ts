import { readSignoff } from "./signoff.cjs";

// The end-to-end assertion limit, a setup file of the end-to-end config. One
// assertion is one `expect` call; jest counts every call, so an `expect` inside a
// helper or a loop counts. `until` is a wait and calls no `expect`, so a test
// that only waits reads 0 and fails here.
const { assertionsPerTest } = readSignoff();

afterEach(() => {
  const made = expect.getState().assertionCalls;
  if (made !== assertionsPerTest) {
    throw new Error(
      `end-to-end assertion limit: this test made ${made} assertion${made === 1 ? "" : "s"}, ` +
        `the sign-off requires exactly ${assertionsPerTest}. Only Brandon allows another.`,
    );
  }
});
