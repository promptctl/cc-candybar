// How scripts/check-protocol.mjs reads a runtime's source text: what counts
// as code, and how each kind of mirrored fact reads as one canonical string.
// Pure text → value functions, so test/protocol-source.test.ts pins them
// directly.

// Source with its comment lines removed, so an anchor read through it matches
// no commented-out copy of what it anchors. A comment line is one whose first
// non-blank characters open a comment (`//`, `///`, `/* … */`, a JSDoc block).
// Telling a comment that FOLLOWS code from a `//` inside a string or regex
// literal takes a lexer per language, so a trailing comment stays, read as
// code: what goes is only what opens a line as a comment.
export function uncommented(text) {
  return text.replace(/^[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/gm, "");
}

// A reader takes a runtime's source and returns the canonical string for one
// mirrored fact, or null when its anchor is missing. [LAW:single-enforcer]
// Every reader is built here, over the source less its comment lines: no
// reader can take a value from a line that opens as a comment, so a region a
// reader slices is delimited by code, never by a comment. A comment trailing
// code on the same line stays (see uncommented): a member it spells is read,
// and fails its row loudly as a phantom. Readers stay that broad on purpose —
// one narrowed to a line shape reads nothing from a layout it did not
// foresee, and a member missing from both sides passes silently.
const overCode =
  (read) =>
  (source, ...anchors) =>
    read(uncommented(source), ...anchors);

// Integer constant, allowing a product expression like `16 * 1024 * 1024`.
export const num = overCode((code, regex) => {
  const m = code.match(regex);
  if (!m) return null;
  // Strip digit-group separators (`3_000`) so both runtimes' idiomatic
  // spellings compare by value, not by punctuation.
  const factors = m[1].split("*").map((s) => s.trim().replace(/_/g, ""));
  if (!factors.every((f) => /^\d+$/.test(f))) return null;
  return String(factors.reduce((acc, f) => acc * Number(f), 1));
});

// String-literal constant. Decodes \xNN, \uNNNN (TS) and \u{...} (Rust)
// escapes so the comparison is on the actual bytes, not the spelling.
export const lit = overCode((code, regex) => {
  const m = code.match(regex);
  if (!m) return null;
  const decoded = m[1]
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  return JSON.stringify(decoded);
});

// A colour as the 24-bit SGR the TS source derives from it: group 1 of `regex`
// is its `#rrggbb`, `layer` is 38 or 48. One runtime states the hex and the
// other the escape, so the row still compares the bytes a terminal receives.
// test/protocol-source.test.ts holds this spelling to the TS derivation.
export const sgrOfHex = overCode((code, regex, layer) => {
  const m = code.match(regex);
  if (!m) return null;
  const channels = [1, 3, 5].map((at) => parseInt(m[1].slice(at, at + 2), 16));
  return JSON.stringify(`\x1b[${layer};2;${channels.join(";")}m`);
});

// Set of string members: collect every capture of a global regex within the
// slice matched by blockRegex, canonicalized as a sorted joined list. A member
// is its capture groups joined by a fixed separator, so a multi-group regex
// compares values, never the formatting between them.
export const memberSet = overCode((code, blockRegex, memberRegex) => {
  const block = code.match(blockRegex);
  if (!block) return null;
  const members = [...block[0].matchAll(memberRegex)].map((m) => m.slice(1).join("="));
  if (members.length === 0) return null;
  return [...new Set(members)].sort().join(", ");
});

// Set of code points in the range table blockRegex's group 1 captures; see
// rangeSpans for how a table reads.
export const codeRanges = overCode((code, blockRegex) => {
  const block = code.match(blockRegex);
  return block ? rangeSpans(block[1]) : null;
});

// Structural marker: every pattern must appear in code; the canonical value is
// the shared description, so both sides agree iff both still use the primitive.
export const markers = overCode((code, patterns, description) =>
  patterns.every((p) => p.test(code)) ? description : null,
);

// Set algebra over canonical member strings, for a row whose value is one
// side's set less, or within, another's. [LAW:one-source-of-truth] The
// canonical form (sorted, ", "-joined) is read and split here only. A null
// operand is a missing anchor, and stays null through the operation.
// The empty set is the empty string, which split would read as one unnamed
// member.
const members = (set) => new Set(set === "" ? [] : set.split(", "));
const keep = (set, test) =>
  set
    .split(", ")
    .filter((m) => test(m))
    .join(", ");

// The members of `set` that none of `others` name.
export function without(set, ...others) {
  if (set === null || others.some((o) => o === null)) return null;
  const named = new Set(others.flatMap((o) => [...members(o)]));
  return keep(set, (m) => !named.has(m));
}

// Every member any of `sets` names.
export function union(...sets) {
  if (sets.some((s) => s === null)) return null;
  return [...new Set(sets.flatMap((s) => [...members(s)]))].sort().join(", ");
}

// The members of `set` that `other` also names.
export function within(set, other) {
  if (set === null || other === null) return null;
  const named = members(other);
  return keep(set, (m) => named.has(m));
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
