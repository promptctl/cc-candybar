import { readSignoff } from "./signoff.cjs";

// The end-to-end assertion limit, a setup file of the end-to-end config. One
// assertion is one matcher invocation, which is what jest counts: `expect(x)`
// alone counts 0, and a matcher inside a helper, a loop or a hook counts. `until`
// is a wait and runs no matcher, so a test that only waits reads 0 and fails
// here. Skipped and todo tests run no hook and are not judged.
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
