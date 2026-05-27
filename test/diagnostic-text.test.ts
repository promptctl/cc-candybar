// [LAW:one-source-of-truth] Tests for the shared sanitize-and-truncate
// primitive used by BOTH src/render/error-glyph.ts (permanent client glyph)
// AND src/daemon/server.ts composeWithDiagnostics (per-render diagnostic
// strip). Behavior asserted here is the contract — caller-side tests
// (error-glyph.test.ts) verify the contract is *applied* in their context;
// this file pins what the contract IS.

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

  test("replaces newlines and other C0 controls with single space", () => {
    expect(sanitizeAndTruncate("a\nb\rc\td", 100)).toBe("a b c d");
  });

  test("collapses runs of whitespace to a single space", () => {
    expect(sanitizeAndTruncate("a    b\n\n\nc", 100)).toBe("a b c");
  });

  test("strips leading and trailing whitespace", () => {
    expect(sanitizeAndTruncate("  hello  ", 100)).toBe("hello");
    expect(sanitizeAndTruncate("\n\nhello\n\n", 100)).toBe("hello");
  });

  test("neutralizes ESC and 8-bit CSI (the ANSI-injection bypasses)", () => {
    // ESC[31m would otherwise re-style the surrounding envelope; U+009B
    // is the 8-bit CSI form (interpreted as `ESC [` by some terminals
    // in 8-bit mode). Both must become spaces to keep the styled
    // diagnostic cell immune to crafted message content.
    const input = "before\x1b[31m middle\x9b[0m after";
    const out = sanitizeAndTruncate(input, 100);
    expect(out).not.toMatch(/\x1b/);
    expect(out).not.toMatch(/\x9b/);
    // The surrounding text survives.
    expect(out).toContain("before");
    expect(out).toContain("middle");
    expect(out).toContain("after");
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

  test("handles a realistic config-error message (newlines + indentation)", () => {
    // Mirrors the actual error daemon emits when a legacy config doesn't
    // validate. The displayed line must be readable as one tight string.
    const input =
      "Invalid config in /Users/bmf/.config/cc-candybar/config.json (2 issues):\n" +
      '  [line 2 • display] Unknown top-level key "display"\n' +
      '  [line 124 • budget] Unknown top-level key "budget"';
    const out = sanitizeAndTruncate(input, 200);
    expect(out).not.toMatch(/[\n\r\t]/);
    expect(out).not.toMatch(/  /); // no double spaces
    expect(out).toContain("Invalid config in");
    expect(out).toContain('[line 2 • display] Unknown top-level key "display"');
    expect(out).toContain('[line 124 • budget]');
  });
});
