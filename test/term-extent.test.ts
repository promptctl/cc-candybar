// [LAW:one-source-of-truth] The same table as rust-client/src/main.rs's
// detect_term_extent test: both runtimes must read the same COLUMNS/LINES
// value from the same shell, or neither.
import { detectTermExtent } from "../src/term-extent";

describe("detectTermExtent parses exactly what the Rust client parses", () => {
  test.each([
    ["80", 80],
    ["+80", 80],
    ["080", 80],
    ["4294967295", 4294967295],
  ])("accepts %j as %d", (env, n) => {
    expect(detectTermExtent(env, 0)).toBe(n);
  });

  test.each(["", "0", " 80", "80 ", "80.5", "80\n", "80abc", "-80", "4294967296"])(
    "rejects %j and falls through to the TTY",
    (env) => {
      expect(detectTermExtent(env, 0)).toBeUndefined();
      expect(detectTermExtent(env, 24)).toBe(24);
    },
  );

  test("no env value: the TTY answer, or nothing", () => {
    expect(detectTermExtent(undefined, 24)).toBe(24);
    expect(detectTermExtent(undefined, 0)).toBeUndefined();
    expect(detectTermExtent(undefined, undefined)).toBeUndefined();
  });
});
