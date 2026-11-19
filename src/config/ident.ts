// The marker that opens an escape, and so the one letter never kept as itself.
const ESCAPE = "Z";

// [LAW:one-source-of-truth] A name spelled injectively as an identifier, by
// escape encoding: an ASCII letter or digit is kept as itself, except
// `ESCAPE`, and every other code point becomes `ESCAPE` and its six hex
// digits, so a synthesized name carries no dot, bracket or other character
// that would break a template field path. `git-2` and `git_2` stay
// `gitZ00002d2` and `gitZ00005f2`: two names never meet in one spelling.
// Every synthesized name built from an authored one is spelled here: a
// menu's state key, edit chrome's preset and placement names.
export function escapedIdent(name: string): string {
  return Array.from(name, (c) =>
    /^[A-Za-z0-9]$/.test(c) && c !== ESCAPE
      ? c
      : // [LAW:no-defensive-null-guards] Array.from yields whole code points.
        `${ESCAPE}${c.codePointAt(0)!.toString(16).padStart(6, "0")}`,
  ).join("");
}
