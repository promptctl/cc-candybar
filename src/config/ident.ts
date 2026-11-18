// [LAW:one-source-of-truth] THE identifier-collapse rule — collapse an
// arbitrary name (a segment, action, preset, or menu-host name) to an
// identifier-shaped fragment so synthesized var/action/segment names carry
// no dots, brackets, or other characters that would break a template field
// path or a synthesis-time accumulator key. Every non-alphanumeric RUN
// collapses to a single `_`.
//
// [LAW:one-source-of-truth] Every site that derives a name by this collapse
// imports it, so the same input always meets the same key: menu-keys.ts
// derives a menu's synthesized SessionState/action identity from it. A name
// that must stay apart from every other is spelled by `escapedIdent` below.
export function ident(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_");
}

// The marker that opens an escape, and so the one letter never kept as itself.
const ESCAPE = "Z";

// [LAW:one-source-of-truth] A name spelled injectively as an identifier, by
// escape encoding: an ASCII letter or digit is kept as itself, except
// `ESCAPE`, and every other code point becomes `ESCAPE` and its six hex
// digits. `ident` would merge `git-2` and `git_2`; these stay `gitZ00002d2`
// and `gitZ00005f2`. Every synthesized name that must stay apart from
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

// [LAW:one-source-of-truth] `escapedIdent` read back: the name it spells, or
// null for a spelling it never produces. A reader of a synthesized name
// re-mints what this returns and compares, so only an exact spelling names a
// name.
export function unescapedIdent(spelled: string): string | null {
  const name = spelled.replace(
    new RegExp(`${ESCAPE}([0-9a-f]{6})`, "g"),
    // A number past the last code point is no escape: it stays as written,
    // and the round trip below refuses it.
    (escape, hex: string) => {
      const point = parseInt(hex, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : escape;
    },
  );
  return escapedIdent(name) === spelled ? name : null;
}
