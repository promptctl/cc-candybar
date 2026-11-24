// A cleanup after a failure (scripts/lib/fail-after.ts) runs, and the failure
// comes out as it was: a cleanup that fails too comes out beside it, never in
// its place.

import { failAfter } from "../../scripts/lib/fail-after";

const caught = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

test("the cleanup runs, and the failure comes out as it was thrown", () => {
  const refused = new TypeError("refusing to boot");
  let cleaned = false;
  expect(
    caught(() =>
      failAfter(refused, () => {
        cleaned = true;
      }),
    ),
  ).toBe(refused);
  expect(cleaned).toBe(true);
});

test("a cleanup that fails too comes out beside the failure, the failure first", () => {
  const refused = new Error("refusing to boot");
  const busy = new Error("EBUSY: resource busy");
  const both = caught(() =>
    failAfter(refused, () => {
      throw busy;
    }),
  );
  expect(both).toBeInstanceOf(AggregateError);
  expect((both as AggregateError).errors).toEqual([refused, busy]);
});
