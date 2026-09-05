// [LAW:behavior-not-structure] Asserts the contract: a terminal extent
// (termCols / termRows) arriving over the wire is sanitized to (positive
// integer ≤ MAX) or undefined before the renderer ever sees it. The renderer
// is allowed to trust the type.

import os from "node:os";
import path from "node:path";
import {
  parseClientHints,
  sanitizeSsh,
  sanitizeTermExtent,
  sanitizeTmux,
} from "../src/daemon/protocol";

describe("sanitizeTermExtent (wire trust boundary)", () => {
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
  ])(
    "rejects non-positive / non-finite / non-number input (%p)",
    (input, expected) => {
      expect(sanitizeTermExtent(input)).toBe(expected);
    },
  );

  test("accepts plain positive integers", () => {
    expect(sanitizeTermExtent(1)).toBe(1);
    expect(sanitizeTermExtent(80)).toBe(80);
    expect(sanitizeTermExtent(200)).toBe(200);
    expect(sanitizeTermExtent(500)).toBe(500);
  });

  test("floors non-integer positives", () => {
    expect(sanitizeTermExtent(80.7)).toBe(80);
    expect(sanitizeTermExtent(0.9)).toBe(undefined); // floors to 0
    expect(sanitizeTermExtent(1.0001)).toBe(1);
  });

  test("caps pathologically large values rather than rejecting", () => {
    expect(sanitizeTermExtent(10000)).toBe(10000);
    expect(sanitizeTermExtent(10001)).toBe(10000);
    expect(sanitizeTermExtent(1e9)).toBe(10000);
    expect(sanitizeTermExtent(Number.MAX_SAFE_INTEGER)).toBe(10000);
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

// [LAW:behavior-not-structure] The tmux hint's THREE-STATE wire semantics:
// `null` is the client's affirmative "not in tmux", an object is the facts,
// and anything else is "no answer" — never "not in tmux", because collapsing
// them is how a client too old to report would read as a healthy setup.
describe("sanitizeTmux (wire trust boundary)", () => {
  const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };

  test("null passes through as null (reported: not in tmux)", () => {
    expect(sanitizeTmux(null)).toBeNull();
  });

  test("a well-formed hint passes through with exactly its three fields", () => {
    expect(sanitizeTmux(HINT)).toEqual(HINT);
    expect(sanitizeTmux({ ...HINT, truecolor: "1" })).toEqual({
      ...HINT,
      truecolor: "1",
    });
    expect(sanitizeTmux({ ...HINT, extra: true })).toEqual(HINT);
  });

  test.each([
    undefined,
    "in-tmux",
    1,
    true,
    [],
    {},
    { socket: "/s" },
    { socket: "", pane: "%1", truecolor: null },
    { socket: "/s", pane: "", truecolor: null },
    { socket: 1, pane: "%1", truecolor: null },
    { socket: "/s", pane: "%1" },
    { socket: "/s", pane: "%1", truecolor: "" },
    { socket: "/s", pane: "%1", truecolor: 1 },
  ])(
    "maps a malformed or absent hint %p to undefined, never to null",
    (input) => {
      expect(sanitizeTmux(input)).toBeUndefined();
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

  test("carries every hint through when the client reported them all", () => {
    expect(
      parseClientHints(
        req({
          termCols: 120,
          termRows: 40,
          ssh: true,
          configEnv: "/etc/candybar.json5",
        }),
      ),
    ).toEqual({
      termCols: 120,
      termRows: 40,
      ssh: true,
      configEnv: "/etc/candybar.json5",
    });
  });

  // brandon-config-5g8: the client's CC_CANDYBAR_CONFIG crosses the wire raw
  // and is made literal at this one checkpoint — the same `~` rule
  // parseRenderArgs applies to `--config`. Empty or non-string is "no
  // override": absent, never an empty path the resolver would look for.
  test("configEnv is ~-expanded, and junk or empty is absent", () => {
    expect(parseClientHints(req({ configEnv: "~/c.json5" })).configEnv).toBe(
      path.join(os.homedir(), "c.json5"),
    );
    expect("configEnv" in parseClientHints(req({ configEnv: "" }))).toBe(false);
    expect("configEnv" in parseClientHints(req({ configEnv: 42 }))).toBe(false);
    expect("configEnv" in parseClientHints(req({}))).toBe(false);
  });

  // termRows is the third hint: same sanitizer as termCols, same absence
  // semantics — an old client, or no TTY, simply does not report it.
  test("termRows is sanitized like termCols and omitted when junk or absent", () => {
    expect(parseClientHints(req({ termCols: 80, termRows: -3 }))).toEqual({
      termCols: 80,
    });
    expect("termRows" in parseClientHints(req({ termCols: 80 }))).toBe(false);
    expect(parseClientHints(req({ termRows: 24.9 })).termRows).toBe(24);
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

  test("tmux:null (not in tmux) is carried, and is NOT absence", () => {
    const hints = parseClientHints(req({ termCols: 80, tmux: null }));
    expect(hints.tmux).toBeNull();
    expect("tmux" in hints).toBe(true);
  });

  test("an absent or malformed tmux hint is omitted, not nulled", () => {
    expect("tmux" in parseClientHints(req({ termCols: 80 }))).toBe(false);
    expect("tmux" in parseClientHints(req({ tmux: "yes" }))).toBe(false);
  });

  test("each hint fails independently — a junk width does not lose a good ssh", () => {
    const hints = parseClientHints(req({ termCols: "wide", ssh: true }));
    expect("termCols" in hints).toBe(false);
    expect(hints.ssh).toBe(true);
  });
});
