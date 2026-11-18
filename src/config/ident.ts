// [LAW:one-source-of-truth] THE identifier-collapse rule — collapse an
// arbitrary name (a segment, action, preset, or menu-host name) to an
// identifier-shaped fragment so synthesized var/action/segment names carry
// no dots, brackets, or other characters that would break a template field
// path or a synthesis-time accumulator key. Every non-alphanumeric RUN
// collapses to a single `_`.
//
// [LAW:no-silent-failure] Every site that derives a name from another runs
// this SAME collapse, so the same input always meets the same key: menu-keys.ts
// derives a menu's synthesized SessionState/action identity from it. One
// function; every site imports it.
export function ident(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_");
}

// [LAW:one-source-of-truth] A name spelled injectively as an identifier, for a
// synthesized name that must stay apart from every other: letters and digits
// as they are except `Z`, and every other code point as `Z` and six hex
// digits. `ident` would merge `git-2` and `git_2`; these stay `gitZ00002d2`
// and `gitZ00005f2`. The spelling holds letters and digits alone, so a key
// that `ident` later derives from names joined around it stays distinct too.
export function exactIdent(name: string): string {
  return Array.from(name, (c) =>
    /^[A-Ya-z0-9]$/.test(c)
      ? c
      : `Z${c.codePointAt(0)!.toString(16).padStart(6, "0")}`,
  ).join("");
}
