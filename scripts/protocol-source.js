// How scripts/check-protocol.mjs reads a runtime's source text: what counts
// as code, and how a table of code-point ranges reads as one set. Pure
// text → value functions, so test/protocol-source.test.ts pins them directly.

// Source with its comment lines removed, so an anchor read through it matches
// no commented-out copy of what it anchors. A comment line is one whose first
// non-blank characters open a comment (`//`, `///`, `/* … */`, a JSDoc block).
// Telling a comment that FOLLOWS code from a `//` inside a string or regex
// literal takes a lexer per language, so a trailing comment stays, read as
// code: what goes is only what opens a line as a comment.
export function uncommented(text) {
  return text.replace(/^[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/gm, "");
}

// The set of code points in the body of a table of inclusive range pairs,
// `[lo, hi]` (TS) or `(lo, hi)` (Rust), in hex or decimal with optional `_`
// separators, canonicalized as merged, sorted spans: two tables read alike iff
// they cover the same code points, however each splits, cases or groups its
// literals. A table body holds only numbers, so here every comment goes,
// trailing ones included.
// [LAW:parse-dont-validate] The body is parsed whole: text no pair accounts
// for, or an inverted pair (a typo that covers nothing), makes it unreadable
// (null) rather than a set short of what it spells.
const RANGE_NUM = String.raw`(0x[0-9a-fA-F_]+|\d[\d_]*)`;
const RANGE_PAIR = new RegExp(String.raw`[[(]\s*${RANGE_NUM}\s*,\s*${RANGE_NUM}\s*[\])]`, "g");
export function rangeSpans(tableBody) {
  const body = tableBody.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  if (body.replace(RANGE_PAIR, "").replace(/[\s,]/g, "") !== "") return null;
  const value = (s) => Number(s.replace(/_/g, ""));
  const pairs = [...body.matchAll(RANGE_PAIR)]
    .map((m) => [value(m[1]), value(m[2])])
    .sort((a, b) => a[0] - b[0]);
  if (pairs.length === 0 || pairs.some(([lo, hi]) => !(lo <= hi))) return null;
  const spans = [];
  for (const [lo, hi] of pairs) {
    const last = spans.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else spans.push([lo, hi]);
  }
  const u = (n) => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;
  return spans.map(([lo, hi]) => `${u(lo)}-${u(hi)}`).join(", ");
}
