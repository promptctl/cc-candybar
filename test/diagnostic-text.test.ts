// [LAW:one-source-of-truth] Tests for the control-character predicate behind
// the sanitize-and-truncate primitive used by BOTH src/render/error-glyph.ts
// (permanent client glyph) AND src/render/diagnostics.ts diagnosticSpan (every
// message the diagnostics viewer shows). What the pass does to a string is the
// fixture both runtimes assert (test/diagnostic-text-cases.test.ts).

import { isControlChar } from "../src/render/diagnostic-text";

describe("isControlChar", () => {
  test("classifies C0 controls (0x00..0x1F) as control", () => {
    for (let code = 0x00; code <= 0x1f; code++) {
      expect(isControlChar(code)).toBe(true);
    }
  });

  test("classifies DEL (0x7F) and C1 controls (0x80..0x9F) as control", () => {
    expect(isControlChar(0x7f)).toBe(true);
    for (let code = 0x80; code <= 0x9f; code++) {
      expect(isControlChar(code)).toBe(true);
    }
  });

  test("classifies the format controls that hold state as control, and the bidi marks as not", () => {
    for (let code = 0x202a; code <= 0x202e; code++) expect(isControlChar(code)).toBe(true);
    for (let code = 0x2066; code <= 0x206f; code++) expect(isControlChar(code)).toBe(true);
    for (const mark of [0x061c, 0x200e, 0x200f]) expect(isControlChar(mark)).toBe(false);
  });

  test("classifies printable ASCII and astral chars as non-control", () => {
    expect(isControlChar(0x20)).toBe(false); // space
    expect(isControlChar(0x41)).toBe(false); // 'A'
    expect(isControlChar(0x7e)).toBe(false); // '~'
    expect(isControlChar(0xa0)).toBe(false); // non-breaking space (above C1)
    expect(isControlChar(0x1f680)).toBe(false); // rocket emoji
  });
});
