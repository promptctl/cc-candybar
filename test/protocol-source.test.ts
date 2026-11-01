// How check-protocol reads source: a range table as one set of code points,
// comment lines as not-code, and every reader over the code alone. A wrong
// reading here passes a drift between the runtimes or fails an equal pair, so
// each rule is pinned on fixed text.
import {
  codeRanges,
  lit,
  markers,
  memberSet,
  num,
  rangeSpans,
  sgrOfHex,
  uncommented,
  union,
  within,
  without,
} from "../scripts/protocol-source";
import {
  DIAGNOSTIC_ERROR_BG,
  DIAGNOSTIC_ERROR_COLORS,
  DIAGNOSTIC_ERROR_FG,
} from "../src/render/diagnostic-style";

// The row reads the hex and the runtime derives the escape, so the two
// spellings of that derivation agree on the colours the glyph writes.
describe("sgrOfHex spells what diagnostic-style derives", () => {
  const read = (hex: string, layer: number): string | null =>
    sgrOfHex(`colour: "${hex}"`, /colour: "(#[0-9a-f]{6})"/, layer);

  it("for the glyph's colours", () => {
    expect(read(DIAGNOSTIC_ERROR_COLORS.fg, 38)).toBe(
      JSON.stringify(DIAGNOSTIC_ERROR_FG),
    );
    expect(read(DIAGNOSTIC_ERROR_COLORS.bg, 48)).toBe(
      JSON.stringify(DIAGNOSTIC_ERROR_BG),
    );
  });
});

const SANITIZER = "U+0000-U+001F, U+007F-U+009F, U+202A-U+202E, U+2066-U+206F";

// Each reader, on source where a commented-out copy of its anchor still
// carries the value the mirror has, above the real anchor that has moved on:
// the reader returns what the runtime runs, never the comment, so the moved
// value is the drift the check reports.
describe("readers take no value from a comment line", () => {
  it("num", () => {
    const src =
      "// export const PROTOCOL_VERSION = 3;\nexport const PROTOCOL_VERSION = 4;\n";
    expect(num(src, /export const PROTOCOL_VERSION = ([\d\s*]+);/)).toBe("4");
    expect(num("const N = 16 * 1_024;", /const N = ([\d\s*_]+);/)).toBe(
      "16384",
    );
    expect(num("// const N = 1;\n", /const N = ([\d\s*]+);/)).toBeNull();
  });

  it("sgrOfHex", () => {
    const src = '// fg: "#000000"\nfg: "#c82828"\n';
    expect(sgrOfHex(src, /fg: "(#[0-9a-f]{6})"/, 38)).toBe(
      JSON.stringify("\x1b[38;2;200;40;40m"),
    );
    expect(sgrOfHex("// fg: \"#000000\"\n", /fg: "(#[0-9a-f]{6})"/, 38)).toBeNull();
  });

  it("lit", () => {
    const src =
      '  // const PREFIX = "\\x1b[1m";\n  const PREFIX = "\\u{1b}[2m";\n';
    expect(lit(src, /const PREFIX = "((?:[^"\\]|\\.)*)";/)).toBe(
      JSON.stringify("\x1b[2m"),
    );
  });

  it("memberSet: a commented copy of the block, and a commented member in it", () => {
    const src = [
      '// export type ErrorCode = "TIMEOUT" | "BAD_REQUEST";',
      "export type ErrorCode =",
      '  | "TIMEOUT"',
      '  // | "BAD_REQUEST"',
      '  | "SWITCHED_OFF";',
    ].join("\n");
    expect(
      memberSet(src, /export type ErrorCode =[^;]+;/, /"([A-Z_]+)"/g),
    ).toBe("SWITCHED_OFF, TIMEOUT");
  });

  it("codeRanges", () => {
    const src = [
      "// const RANGES = [[0x00, 0x1f], [0x7f, 0x9f]] as const;",
      "const RANGES = [",
      "  [0x00, 0x1f],",
      "] as const;",
    ].join("\n");
    expect(codeRanges(src, /const RANGES = \[([\s\S]*?)\] as const;/)).toBe(
      "U+0000-U+001F",
    );
  });

  it("markers", () => {
    expect(
      markers(
        "// to_be_bytes()\nfrom_be_bytes()",
        [/to_be_bytes/],
        "u32 big-endian",
      ),
    ).toBeNull();
    expect(markers("to_be_bytes()", [/to_be_bytes/], "u32 big-endian")).toBe(
      "u32 big-endian",
    );
  });
});

// A row whose value is one side's set less, or within, another's, read on the
// canonical form the readers produce; a missing anchor on either side stays
// the null the runner fails on.
describe("without, union and within", () => {
  it("without keeps the members none of the others name", () => {
    expect(without("a, b, c", "b", "c, d")).toBe("a");
    expect(without("a, b", "z")).toBe("a, b");
    expect(without(null, "a")).toBeNull();
    expect(without("a", "b", null)).toBeNull();
  });

  it("union names every member once, sorted", () => {
    expect(union("c, a", "b, a")).toBe("a, b, c");
    expect(union("a", null)).toBeNull();
    expect(union(without("a", "a"), "b")).toBe("b");
    expect(without("", "x")).toBe("");
  });

  it("within keeps the members the other also names", () => {
    expect(within("a, b, c", "c, a, z")).toBe("a, c");
    expect(within("a", null)).toBeNull();
    expect(within(null, "a")).toBeNull();
  });
});

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
