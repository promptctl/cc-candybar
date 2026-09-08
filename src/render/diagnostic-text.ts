// [LAW:one-source-of-truth] The single sanitize-and-truncate primitive for text spliced
// into an ANSI-styled envelope, so the neutralization rules cannot drift between callers.
// [LAW:types-are-the-program] Pure functions over strings; the envelope is the caller's.

const ELLIPSIS = "…";

// [LAW:dataflow-not-control-flow] Every code point flows through one predicate: the
// Unicode Cc class. The C1 range matters because some terminals read U+009B as 8-bit CSI.
// Mirrors rust-client/src/error_glyph.rs, so both runtimes neutralize the same classes.
export function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

// Neutralization without the cap: the diagnostic strip wraps rather than clips.
export function sanitizeText(text: string): string {
  let sanitized = "";
  for (const ch of text) {
    sanitized += isControlChar(ch.codePointAt(0) ?? 0) ? " " : ch;
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

// [LAW:dataflow-not-control-flow] One pass; visible length stays at maxLen when truncation happens.
export function sanitizeAndTruncate(text: string, maxLen: number): string {
  // Sanitize before counting: a control char and its replacement are both one visible code point.
  const sanitized = sanitizeText(text);

  // The /.$/u regex matches a full code point, not a UTF-16 unit — emoji in paths.
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
