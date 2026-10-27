// [LAW:one-source-of-truth] The diagnostic sanitizer's behaviour, from the one
// table both runtimes assert (test/fixtures/diagnostic-sanitize-cases.json):
// the native client's `sanitize` (rust-client/src/error_glyph.rs) reads the
// same file, so a collapse or neutralize rule changed in one runtime fails the
// other's test. check-protocol pins what a literal can state (the range
// tables, the fold); the whitespace predicates' agreement is behaviour, so it
// lives here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeText } from "../src/render/diagnostic-text";

interface Cases {
  readonly cases: readonly { readonly input: string; readonly output: string }[];
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "diagnostic-sanitize-cases.json"), "utf8"),
) as Cases;

// The title spells every code point outside printable ASCII as \uXXXX: the
// inputs carry ESC, 8-bit CSI and bidi overrides, and a title that prints
// them raw re-styles the failure report. (%j is not enough: JSON leaves
// U+009B and U+202E raw.)
const escaped = (s: string): string =>
  s.replace(/[^\x20-\x7e]/gu, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);

test.each(CASES.cases.map((c) => [escaped(c.input), c] as const))(
  'sanitizeText "%s"',
  (_, { input, output }) => {
    expect(sanitizeText(input)).toBe(output);
  },
);
