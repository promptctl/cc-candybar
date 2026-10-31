// [LAW:one-source-of-truth] The single sanitize-and-truncate primitive for
// any diagnostic text we embed inside a single-line, ANSI-styled envelope.
// Two callers today:
//   - src/render/error-glyph.ts (permanent client-side glyph; budget 60)
//   - src/render/diagnostics.ts (the diagnostics viewer, carrying the actual
//     config error/warning message; sanitize only — it wraps)
// A third copy in the daemon would duplicate the security-critical
// control-char neutralization rules; sharing the primitive guarantees the
// rules cannot drift between callers.
//
// [LAW:types-are-the-program] Pure functions over strings. The contract is
// exactly: "make this text safe to splice into an ANSI-styled cell" —
// sanitizeText — and, for the single-line callers, "…clipped to maxLen
// visible code points" — sanitizeAndTruncate. Anything else is the caller's
// responsibility (which icon, which colors, which click verb).

const ELLIPSIS = "…";

// [LAW:dataflow-not-control-flow] Every code point flows through the same
// predicate, a fold over one table of ranges. No special-case branches per
// kind of control; the table is the single discriminator that decides "this
// code point could hijack the envelope and must be neutralized."
//
// Why the C1 range matters (0x80..0x9F):
//   ESC (U+001B) is the obvious ANSI-escape entry point, but some
//   terminals interpret U+009B as 8-bit CSI directly — i.e. equivalent to
//   ESC `[`. Sanitizing only the C0 range (≤0x1F + 0x7F) would leave the
//   8-bit bypass open. With diagnostic messages echoing user-supplied
//   data (config paths, key names, parse errors), that's reachable from
//   crafted input even without a malicious daemon.
//
// Beyond Cc, the format controls that hold state past the text are
// neutralized too: the bidi embeddings and overrides with their closer
// (U+202A..U+202E), the isolates with theirs and the deprecated shaping
// switches (U+2066..U+206F). An unclosed U+202E echoed into a diagnostic
// reverses the rest of the line. These are the ranges rich-js's Text strips
// from every segment's text (brandon-unfiled-3248.qum).
//
// [LAW:one-source-of-truth] Mirrored by rust-client/src/error_glyph.rs's
// `NEUTRALIZED_RANGES` and `neutralized()`. scripts/check-protocol.mjs holds
// the two tables to one set of code points and both predicates (and their
// one use) to the bare fold, so a change to either runtime's set alone fails
// `pnpm check:protocol`. The Rust side also mirrors the collapse-whitespace-
// runs + trim pass below, so the two runtimes produce byte-identical output;
// that is behaviour, not a literal, so both suites assert the one case
// table at test/fixtures/diagnostic-text-cases.json.
//
// Inclusive ranges: C0 (U+0000..U+001F), DEL and C1 (U+007F..U+009F) — the
// Unicode Cc class — then the two bidi/format ranges above.
const NEUTRALIZED_RANGES = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x202a, 0x202e],
  [0x2066, 0x206f],
] as const;

export function isControlChar(code: number): boolean {
  return NEUTRALIZED_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

// Sanitize control characters (→ single space) and collapse whitespace runs
// to one space so multi-line indented messages don't display as awkwardly-
// spaced single lines. The envelope-safety half of the contract, on its own:
// the diagnostics viewer (src/render/diagnostics.ts) wraps to the
// terminal instead of clipping, so it needs the neutralization without the
// cap.
export function sanitizeText(text: string): string {
  let sanitized = "";
  for (const ch of text) {
    sanitized += isControlChar(ch.codePointAt(0) ?? 0) ? " " : ch;
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

// Sanitize, then clip to maxLen visible code points, ending with an ellipsis
// if the input was longer.
//
// [LAW:dataflow-not-control-flow] One pass over the input; the trailing
// `.replace(/.$/u, ELLIPSIS)` is the only branch and only fires when we
// hit the cap. The cap-then-ellipsis is the same pattern error-glyph used
// pre-extraction (preserved byte-for-byte: visible length stays at maxLen
// when truncation happens).
export function sanitizeAndTruncate(text: string, maxLen: number): string {
  // Sanitize before counting: a control char and its replacement space are
  // both one visible code point — equal contributions to length.
  const sanitized = sanitizeText(text);

  // Truncate-with-ellipsis. The /.$/u regex matches a full code point
  // (unicode flag), not a UTF-16 unit — important for emoji and other
  // astral-plane chars in user-supplied paths.
  let out = "";
  let count = 0;
  for (const ch of sanitized) {
    if (count === maxLen) {
      return out.replace(/.$/u, ELLIPSIS);
    }
    out += ch;
    count++;
  }
  return out;
}
