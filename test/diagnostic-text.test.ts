// [LAW:one-source-of-truth] Tests for the shared sanitize-and-truncate
// primitive used by BOTH src/render/error-glyph.ts (permanent client glyph)
// AND src/render/diagnostic-strip.ts composeWithDiagnostics (per-render
// diagnostic strip). This file pins the predicate's ranges and the clip; what the
// sanitizer does to a string is the fixture both runtimes assert
// (test/diagnostic-sanitize-cases.test.ts).

import {
  sanitizeAndTruncate,
  isControlChar,
} from "../src/render/diagnostic-text";

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

describe("sanitizeAndTruncate", () => {
  test("passes short ASCII through unchanged", () => {
    expect(sanitizeAndTruncate("hello world", 100)).toBe("hello world");
  });

  test("truncates with ellipsis when input exceeds maxLen", () => {
    const input = "x".repeat(200);
    const out = sanitizeAndTruncate(input, 60);
    expect([...out].length).toBe(60); // visible length budget honored
    expect(out.endsWith("…")).toBe(true);
  });

  test("does not append ellipsis when input fits", () => {
    expect(sanitizeAndTruncate("hi", 60).endsWith("…")).toBe(false);
  });

  test("truncation counts code points, not UTF-16 units (astral-safe)", () => {
    // 100 rockets = 100 code points but 200 UTF-16 units. A UTF-16-based
    // truncate would split a surrogate pair; this must count code points.
    const input = "🚀".repeat(100);
    const out = sanitizeAndTruncate(input, 60);
    expect([...out].length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });
});
