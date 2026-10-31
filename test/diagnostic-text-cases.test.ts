// [LAW:one-source-of-truth] [LAW:one-type-per-behavior] The diagnostic text
// pass's behaviour, from the one table both runtimes assert
// (test/fixtures/diagnostic-text-cases.json): the native client's `sanitize`,
// `truncate` and `format_permanent_glyph` (rust-client/src/error_glyph.rs) read
// the same file, so a collapse, neutralize, clip or label rule changed in one
// runtime fails the other's test. check-protocol pins what a literal can state
// (the range tables, the fold, that the budgets agree); what the pass does to a
// string is behaviour, so it lives here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PermanentOutcome } from "../src/daemon/client-transport";
import { sanitizeAndTruncate, sanitizeText } from "../src/render/diagnostic-text";
import { formatPermanentGlyph } from "../src/render/error-glyph";

interface Cases {
  readonly glyph: readonly {
    readonly cause: Extract<PermanentOutcome, { message: string }>["cause"];
    readonly message: string;
    readonly output: string;
  }[];
  readonly sanitize: readonly { readonly input: string; readonly output: string }[];
  readonly clip: readonly {
    readonly input: string;
    readonly budget: number;
    readonly output: string;
  }[];
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "diagnostic-text-cases.json"), "utf8"),
) as Cases;

// The title spells every code point outside printable ASCII as \uXXXX: the
// inputs carry ESC, 8-bit CSI and bidi overrides, and a title that prints
// them raw re-styles the failure report. (%j is not enough: JSON leaves
// U+009B and U+202E raw.)
const escaped = (s: string): string =>
  s.replace(/[^\x20-\x7e]/gu, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);

test.each(CASES.glyph.map((c) => [c.cause, c] as const))(
  "formatPermanentGlyph %s",
  (cause, { message, output }) => {
    expect(formatPermanentGlyph({ kind: "permanent", cause, message })).toBe(output);
  },
);

test.each(CASES.sanitize.map((c) => [escaped(c.input), c] as const))(
  'sanitizeText "%s"',
  (_, { input, output }) => {
    expect(sanitizeText(input)).toBe(output);
  },
);

test.each(CASES.clip.map((c) => [escaped(c.input), c.budget, c] as const))(
  'sanitizeAndTruncate "%s" to %d',
  (_, budget, { input, output }) => {
    expect(sanitizeAndTruncate(input, budget)).toBe(output);
  },
);
