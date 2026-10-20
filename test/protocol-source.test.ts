// How check-protocol reads source: a range table as one set of code points,
// and comment lines as not-code. A wrong reading here passes a drift between
// the runtimes or fails an equal pair, so each rule is pinned on fixed text.
import { rangeSpans, uncommented } from "../scripts/protocol-source";

const SANITIZER = "U+0000-U+001F, U+007F-U+009F, U+202A-U+202E, U+2066-U+206F";

describe("rangeSpans", () => {
  it("reads a TS table and a Rust table of one set alike", () => {
    expect(
      rangeSpans(
        "[0x00, 0x1f], [0x7f, 0x9f], [0x202a, 0x202e], [0x2066, 0x206f],",
      ),
    ).toBe(SANITIZER);
    expect(
      rangeSpans(
        "(0x00, 0x1F),\n(0x7F, 0x9F),\n(0x202A, 0x202E),\n(0x2066, 0x206F),",
      ),
    ).toBe(SANITIZER);
  });

  it("reads by the code points covered, not the spelling", () => {
    const split =
      "(0x2066, 0x206F), (0x202A, 0x202E), (0x9a, 0x9F), (0x7F, 0x99), (0, 31)";
    expect(rangeSpans(split)).toBe(SANITIZER);
    expect(rangeSpans("[0x20_2A, 0x20_2E]")).toBe("U+202A-U+202E");
    expect(rangeSpans("[0x10, 0x20], [0x18, 0x30]")).toBe("U+0010-U+0030");
  });

  it("keeps ranges a code point apart separate", () => {
    expect(rangeSpans("[0x00, 0x1f], [0x21, 0x22]")).toBe(
      "U+0000-U+001F, U+0021-U+0022",
    );
  });

  it("reads no range out of a comment, trailing or whole-line", () => {
    expect(rangeSpans("[0x00, 0x1f], // was [0x7f, 0x9f]\n")).toBe(
      "U+0000-U+001F",
    );
    expect(rangeSpans("/* [0x7f, 0x9f] */ [0x00, 0x1f]")).toBe("U+0000-U+001F");
  });

  it("is unreadable when any text is not a pair", () => {
    expect(rangeSpans("(0x00u32, 0x1F)")).toBeNull();
    expect(rangeSpans("[0X7F, 0X9F]")).toBeNull();
    expect(rangeSpans("[0x00, 0x1f], LOW")).toBeNull();
  });

  it("is unreadable for an inverted pair or an empty table", () => {
    expect(rangeSpans("[0x00, 0x1f], [0x9f, 0x7f]")).toBeNull();
    expect(rangeSpans("  ")).toBeNull();
  });
});

describe("uncommented", () => {
  it("removes lines that open as comments", () => {
    const src = [
      "// was: const NEUTRALIZED_RANGES = [[0x00, 0x1f]] as const;",
      "    /// let ch = if neutralized(raw) { ' ' } else { raw };",
      "/**",
      " * fn neutralized(ch: char) -> bool {",
      " */",
      "real();",
    ].join("\n");
    expect(uncommented(src).trim()).toBe("real();");
  });

  it("keeps code after a block comment that closes mid-line", () => {
    expect(uncommented("  /* DEL and C1 */ (0x7F, 0x9F),")).toBe(
      " (0x7F, 0x9F),",
    );
  });

  it("never removes code: a `//` or `/*` after code stays", () => {
    const src =
      'const a = "x // y"; real();\nfoo();// c /*\nreal2();\nconst u = "cc-candybar://x";';
    expect(uncommented(src)).toBe(src);
  });
});
