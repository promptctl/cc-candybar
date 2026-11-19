// [LAW:one-type-per-behavior] The fold every setting and every `state`
// variable reads a session's stored spelling through: what a session holds,
// read against a domain, and the precedence that turns it into the value in
// force. A leaf, imported by the loader, the render and the click verbs alike
// [LAW:one-way-deps].

// [LAW:types-are-the-program][LAW:one-type-per-behavior] What a session holds
// for one setting, read against that setting's domain — one shape for every
// setting: nothing stored, a value of the domain, or a stored spelling the
// domain does not hold, carried as written. The third is a pick made under a
// build or config whose domain held it, which is not "no pick": a fold passing
// over it can say what it passed over.
export type Stored<T> =
  | { readonly kind: "unset" }
  | { readonly kind: "held"; readonly value: T }
  | { readonly kind: "stale"; readonly stored: string };

// [LAW:parse-dont-validate] A stored spelling read through `member`, the
// setting's own parse of one spelling into its domain.
export function readStored<T>(
  raw: string | null,
  member: (raw: string) => T | null,
): Stored<T> {
  if (raw === null) return { kind: "unset" };
  const value = member(raw);
  return value === null
    ? { kind: "stale", stored: raw }
    : { kind: "held", value };
}

// What a fold decided: the value in force, and the stored spelling it passed
// over where the session's rung would have been in force — null when it passed
// over none.
export interface Folded<T> {
  readonly value: T;
  readonly stale: string | null;
}

// [LAW:one-type-per-behavior] THE resolution every setting a click can pick
// shares: the staged fragment over the session's own value, over the config
// default, over a floor. Written once because the settings differ only in DATA
// — which floor, and the parse that reads the session's spelling (`Stored`) —
// so the precedence cannot land on one setting and miss another.
//
// [LAW:dataflow-not-control-flow] The `??` chain IS the precedence; there is no
// "does this session have one" branch, and no "is edit mode on" branch: an
// absent rung is `undefined`, skipped by the same path every rung takes.
//
// [LAW:no-silent-failure] A stale pick falls through to the next rung, so the
// bar still draws, and the fold says what it passed over. That is reported only
// where the session's rung would have been in force: a staged value outranks
// it, and hides it. The stored spelling stays where it is, so a domain restored
// brings the pick back.
//
// [LAW:one-source-of-truth] `staged` is the RIGHTMOST rung of the precedence
// chain documented in src/config/presets.ts — a fragment some transient MODE of
// the bar puts on top while it is on (today: edit mode's `editGlobals`). It
// outranks even the session pick because it is decided LATER: a user picks a
// style, then afterwards enters edit mode.
export function effectiveGlobal<T>(
  staged: T | null | undefined,
  session: Stored<T>,
  configDefault: T | null | undefined,
  floor: T,
): Folded<T> {
  const picked = session.kind === "held" ? session.value : null;
  return {
    value: staged ?? picked ?? configDefault ?? floor,
    stale: staged == null && session.kind === "stale" ? session.stored : null,
  };
}

// [LAW:types-are-the-program] A pick a fold passed over, as data: the setting
// it was stored for, the spelling stored, and what the setting's domain adds
// about that spelling (a retired theme's successor). Nothing here says what
// the bar wears in its place, since a rule's answer is known only to the draw,
// which composes the report (`stalePick`).
export interface StaleMiss<S extends string = string> {
  readonly setting: S;
  readonly stored: string;
  readonly note: string;
}

// [LAW:one-source-of-truth] The one spelling of "this could not be honoured,
// so the bar wears something else": where it was written, what the bar wears
// instead, and why — a stale pick, a rule that threw, a rule's result naming
// no installed theme.
export function fallbackMessage(
  where: string,
  wears: string,
  why: string,
): string {
  return `${where} rendered ${wears}: ${why}`;
}
