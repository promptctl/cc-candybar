// [LAW:behavior-not-structure] Asserts the contract: termCols arriving over
// the wire is sanitized to (positive integer ≤ MAX) or undefined before the
// renderer ever sees it. The renderer is allowed to trust the type.

import {
  parseClientHints,
  sanitizeSsh,
  sanitizeTermCols,
} from "../src/daemon/protocol";

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

// [LAW:behavior-not-structure] The contract under test is the THREE-STATE
// wire semantics of the ssh hint, not how it is spelled. `false` and
// "no answer" must stay distinguishable all the way through the boundary,
// because collapsing them is precisely how a client that is too old to report
// would get silently rendered as a confirmed-local session.
describe("sanitizeSsh (wire trust boundary)", () => {
  test("passes both booleans through unchanged", () => {
    expect(sanitizeSsh(true)).toBe(true);
    expect(sanitizeSsh(false)).toBe(false);
  });

  // undefined = the field omitted, i.e. a client too old to report; the rest
  // are shapes a malformed or hostile frame could carry. Every one of them is
  // "no answer", and none of them is the answer `false`.
  test.each([undefined, null, "true", "false", 1, 0, {}, []])(
    "maps non-boolean %p to undefined, never to false",
    (input) => {
      expect(sanitizeSsh(input)).toBeUndefined();
    },
  );
});

describe("parseClientHints (the one wire checkpoint)", () => {
  const req = (extra: Record<string, unknown>) =>
    ({
      v: 3,
      kind: "render",
      hookData: {},
      args: [],
      cwd: "/tmp",
      ...extra,
    }) as never;

  test("carries both hints through when the client reported both", () => {
    expect(parseClientHints(req({ termCols: 120, ssh: true }))).toEqual({
      termCols: 120,
      ssh: true,
    });
  });

  test("a reported-local session yields ssh:false, which is NOT absence", () => {
    const hints = parseClientHints(req({ termCols: 80, ssh: false }));
    expect(hints.ssh).toBe(false);
    expect("ssh" in hints).toBe(true);
  });

  // The old-client case: `cc-candybar install` stages a native binary that does
  // not turn over with the npm package, so a current daemon really does serve
  // clients predating the hint.
  test("omits ssh entirely when the client did not report it", () => {
    const hints = parseClientHints(req({ termCols: 80 }));
    expect("ssh" in hints).toBe(false);
    expect(hints.termCols).toBe(80);
  });

  test("each hint fails independently — a junk width does not lose a good ssh", () => {
    const hints = parseClientHints(req({ termCols: "wide", ssh: true }));
    expect("termCols" in hints).toBe(false);
    expect(hints.ssh).toBe(true);
  });
});
