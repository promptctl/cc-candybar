// [LAW:behavior-not-structure] Asserts the contract: termCols arriving over
// the wire is sanitized to (positive integer ≤ MAX) or undefined before the
// renderer ever sees it. The renderer is allowed to trust the type.

import { sanitizeTermCols } from "../src/daemon/protocol";

describe("sanitizeTermCols (wire trust boundary)", () => {
  test.each([
    [undefined, undefined],
    [null, undefined],
    ["80", undefined],
    [{}, undefined],
    [[], undefined],
    [true, undefined],
    [NaN, undefined],
    [Infinity, undefined],
    [-Infinity, undefined],
    [0, undefined],
    [-1, undefined],
    [-200, undefined],
  ])("rejects non-positive / non-finite / non-number input (%p)", (input, expected) => {
    expect(sanitizeTermCols(input)).toBe(expected);
  });

  test("accepts plain positive integers", () => {
    expect(sanitizeTermCols(1)).toBe(1);
    expect(sanitizeTermCols(80)).toBe(80);
    expect(sanitizeTermCols(200)).toBe(200);
    expect(sanitizeTermCols(500)).toBe(500);
  });

  test("floors non-integer positives", () => {
    expect(sanitizeTermCols(80.7)).toBe(80);
    expect(sanitizeTermCols(0.9)).toBe(undefined); // floors to 0
    expect(sanitizeTermCols(1.0001)).toBe(1);
  });

  test("caps pathologically large values rather than rejecting", () => {
    expect(sanitizeTermCols(10000)).toBe(10000);
    expect(sanitizeTermCols(10001)).toBe(10000);
    expect(sanitizeTermCols(1e9)).toBe(10000);
    expect(sanitizeTermCols(Number.MAX_SAFE_INTEGER)).toBe(10000);
  });
});
