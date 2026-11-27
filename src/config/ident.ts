// Template paths, setting and environment names, and authored row names share
// this token. A leading digit would allow integer keys to reorder authored rows.
export const IDENTIFIER_TOKEN = "[A-Za-z_][A-Za-z0-9_]*";
export const IDENTIFIER = new RegExp(`^${IDENTIFIER_TOKEN}(?![\\s\\S])`);

// The marker that opens an escape, and so the one letter never kept as itself.
const ESCAPE = "Z";
const MAX_CODE_POINT = 0x10ffff;

// [LAW:one-source-of-truth] A name spelled injectively as an identifier, by
// escape encoding: an ASCII letter or digit is kept as itself, except
// `ESCAPE`, and every other code point becomes `ESCAPE` and its six hex
// digits, so `git-2` and `git_2` stay `gitZ00002d2` and `gitZ00005f2`. Every synthesized name that must stay apart from
// another, such as edit chrome's preset and placement names, is spelled
// here.
export function escapedIdent(name: string): string {
  return Array.from(name, (c) =>
    /^[A-Za-z0-9]$/.test(c) && c !== ESCAPE
      ? c
      : // [LAW:no-defensive-null-guards] Array.from yields whole code points.
        `${ESCAPE}${c.codePointAt(0)!.toString(16).padStart(6, "0")}`,
  ).join("");
}

// The name `escapedIdent` spelled, or undefined for a spelling it never
// makes.
export function unescapedIdent(spelled: string): string | undefined {
  // [LAW:parse-dont-validate] An escape past the last code point is left as
  // written, and its `ESCAPE` then fails the round trip below.
  const name = spelled.replace(
    new RegExp(`${ESCAPE}([0-9a-f]{6})`, "g"),
    (escape, hex: string) =>
      parseInt(hex, 16) > MAX_CODE_POINT
        ? escape
        : String.fromCodePoint(parseInt(hex, 16)),
  );
  return escapedIdent(name) === spelled ? name : undefined;
}
