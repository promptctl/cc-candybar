// Run only by test/integration/quarantine-gate. Nothing here is listed. A skipped
// case beside a case that runs, under a beforeAll that throws, comes out of jest
// pending and carrying the failure, the same shape as a case the quarantine let
// through, so the record must not read that shape as proof of a quarantine.

describe("before all", () => {
  beforeAll(() => {
    throw new Error("the beforeAll failed");
  });

  test("a case that runs", () => {});

  test.skip("a skipped case", () => {});
});
