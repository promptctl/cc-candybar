// [LAW:types-are-the-program] The author-facing SHAPE of a decoupled, named
// ACTION — the config-file schema for `DslConfig.actions`. Pure data (no engine,
// no rich-js): the strongest theorem about what a user can declare. The loader
// narrows `unknown` to these; the runtime (render/action.ts) and the validator
// derivation (daemon/verbs/state-validators.ts) consume them.
//
// [LAW:locality-or-seam] An action is the SEAM between the clickable
// REPRESENTATION (a template region, `{{ action "name" … }}`) and the BEHAVIOR
// (what the click does). They are joined by NAME: re-glyph a button without
// touching behavior; re-target an action without touching the template. This is
// the successor to the widget surface — a widget couples representation and
// behavior in one declaration; an action splits them so one template expresses
// anything (text, state-driven display, clickable regions) and the action table
// is the single, statically-enumerable set of effects those regions can fire.
//
// [LAW:one-source-of-truth] Because a `set` action carries its key and value
// SOURCE as literal data (a literal `to`, an option domain, or numeric bounds),
// the writable-key gate DERIVES from the action table (deriveActionValidators).
// A template references a NAME; it cannot smuggle an un-gated write. The rendered
// click and the gate share ONE source — the action declaration.
//
// [LAW:one-source-of-truth] The option-domain + effect-verb vocabulary lives
// HERE — action.ts is the surviving home now that the widget surface is gone.
// These are the shapes a picker draws options from and the set/copy/open/int
// discriminator the loader and the validator-derivation match on.

// [LAW:one-source-of-truth] The domain a picker draws options from. Resolved
// through option-domain.ts's registry — themes/styles are registry-backed
// static lists, "looks" is the one PER-CONFIG domain (the merged `looks`
// block's names, threaded as data rather than consulted from a module
// constant), and an inline array is its own domain, needing no registration
// at all. Re-exported here so ActionDecl stays self-contained to read.
import type { OptionDomain } from "./option-domain.js";
export type { OptionDomain } from "./option-domain.js";

// [LAW:types-are-the-program] The top-level discriminator of an ActionDecl — the
// click effect is keyed by which of these is present. The loader proves
// exactly-one-of; the renderer and validator-derivation match with no fallthrough.
//
// [LAW:one-source-of-truth] `persist` is `set`'s PERSISTENT twin: `set`
// mutates per-session SessionState, `persist` mutates the config's DEFAULT
// by writing the config FILE itself (candybar-config-dqe — the one durable
// store; the write splices the value in place so the file's comments
// survive). `reset` deletes that key's path from the file — the gated undo
// `persist` needs, since a machine write with no way back would be a
// one-way ratchet.
//
// [LAW:one-source-of-truth] `undo`/`redo` (brandon-layout-edit-2gc.2) are
// `reset`'s FINE-GRAINED siblings: `reset` deletes one named key outright
// (the coarse "forget this default" case); `undo`/`redo` step the history
// of every durable edit made to the session's config file — whole-file
// snapshots, every key, not just structural layout edits — back and forth.
// Neither carries a key: a file's history is one stack (config-file-store.ts
// owns one per file), so the action is a bare marker, like `int: true` is
// for a set-int cursor.
export const ACTION_KEYS = [
  "set",
  "persist",
  "copy",
  "open",
  "reset",
  "undo",
  "redo",
  "doctor",
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

// [LAW:types-are-the-program] An ActionDecl is the click effect a named action
// binds to. The top-level discriminator is which of `set`/`copy`/`open` is
// present (the CacheDecl/widget-Action pattern); a `set` is sub-discriminated by
// its value SOURCE — `to` (literal), `from` (option-bound), or `min/max/by`
// (bounded step). The loader proves exactly-one-of at each level; the renderer
// and the validator-derivation match on the present key with no fallthrough.
//
//   set + to            — write a literal value -> allow-list {to}
//   set + from          — write the option the template binds at render
//                         (a picker ranges the domain — a registered name like
//                         "themes", or an inline literal array) -> allow-list
//                         {options}
//   set + min/max/by    — write wrap(current ± by) clamped to [min,max]
//                         (a stepper affordance) -> range [min,max]
//   set + int           — write any integer the render binds (a paged cursor:
//                         -1 closed / 0..N pages, clamp owned by the renderer)
//                         -> int gate (unbounded). The missing primitive a
//                         width-paginated picker needs — its page key accepts any
//                         integer, which no bounded/literal arm can express.
//   set + cycle         — write the SUCCESSOR of the current value in the
//                         member list, wrapping; a current value outside the
//                         domain counts as the first member (so the second
//                         member is the "first click" target — order members
//                         default-state-first). The bounded stepper's sibling:
//                         a stepper steps a range, a cycle steps an enumerated
//                         domain (toggles, N-state cyclers, accordion paths)
//                         -> allow-list {members}
//   copy                — copy templated text to the clipboard -> no gate
//   open                — open a templated target in the editor -> no gate
//   undo                — step the config-edit history one
//                         entry back (any persist/reset write, not just a
//                         layout op) -> no gate, no key: there is nothing a
//                         template could smuggle, since the value restored is
//                         whatever the daemon's own history recorded, never
//                         wire input
//   redo                — the inverse of undo: re-apply the most recently
//                         undone entry -> no gate, no key
//   removeSegment       — (persist only) remove the named segment from the
//                         preset-root the `persist` key addresses
//                         (`presets.<name>.root`) -> allow-list {one op
//                         token — see src/config/layout-ops.ts}
//   insertSegment +
//     anchor + relation  — (persist only) insert a named segment before/after
//                         an existing one, same key shape -> allow-list {one
//                         op token}
//   insertSegmentFrom +
//     anchor + relation  — (persist only) insertSegment's domain-sourced
//                         sibling (brandon-layout-edit-2gc.3): the segment
//                         name is picked from an option domain at render
//                         (a `{{ menu }}`'s bound option) rather than fixed
//                         at author time -> allow-list {one op token per
//                         domain member}
//
// [LAW:one-source-of-truth] `set` writes SessionState and `persist` writes
// the config file, so only those two derive a validator (through
// the SAME shared registry algebra — see validator-registry.ts). copy/open/
// reset write nothing SPEC-shaped (reset's target is gated by key membership,
// not a value domain) — they derive nothing. The vocabulary grows by arms (a
// future `run`/`open-url`), not by validator plumbing.
//
// [LAW:one-type-per-behavior] `persist` mirrors `set`'s four value-source
// arms verbatim (to/from/min-max-by/cycle) MINUS `int`: an unbounded page
// cursor is a UI-only paging concept (a picker's own navigation state) with
// no meaning as a persisted config default.
//
// [LAW:locality-or-seam] `removeSegment`/`insertSegment` are `persist`-ONLY
// (brandon-layout-edit-2gc.1) — a structural edit is always a durable write
// to the config file by design, so there is no SessionState twin. Every operation is fully literal at config-author time — the
// segment names and relation are DATA the loader proves at load, not a
// runtime picker — so each declared action has exactly one legal request,
// gated the same one-member-allow-list way a literal `to` already is.
export type ActionDecl =
  | { readonly set: string; readonly to: string }
  | { readonly set: string; readonly from: OptionDomain }
  | {
      readonly set: string;
      readonly min: number;
      readonly max: number;
      readonly by: number;
    }
  | { readonly set: string; readonly int: true }
  | { readonly set: string; readonly cycle: readonly string[] }
  | { readonly persist: string; readonly to: string }
  | { readonly persist: string; readonly from: OptionDomain }
  | {
      readonly persist: string;
      readonly min: number;
      readonly max: number;
      readonly by: number;
    }
  | { readonly persist: string; readonly cycle: readonly string[] }
  | { readonly persist: string; readonly removeSegment: string }
  | {
      readonly persist: string;
      readonly insertSegment: string;
      readonly anchor: string;
      readonly relation: "before" | "after";
    }
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.3's DOMAIN-SOURCED
  // sibling of `insertSegment`: the same tree op, but the segment name comes
  // from the template's bound option (a picker/menu cell) instead of being
  // fixed at config-author time — exactly the `to`-vs-`from` split `set`/
  // `persist` already draw, one arm over. `anchor`/`relation` stay literal
  // (the POSITION is still author-time data; only WHICH segment lands there
  // is picked at render). This is what makes a `{{ menu "insertHere" }}`
  // legal over a structural edit: `requireOptionKind` (render/picker.ts)
  // admits it alongside set-option/persist-option, and the click writes
  // `encodeLayoutOp({ op: "insert", segment: <picked>, anchor, relation })` —
  // the SAME wire shape a literal `insertSegment` action emits, so undo/redo
  // and the daemon's apply-layout-op handler need no changes at all.
  | {
      readonly persist: string;
      readonly insertSegmentFrom: OptionDomain;
      readonly anchor: string;
      readonly relation: "before" | "after";
    }
  | { readonly copy: string }
  | { readonly open: string }
  | { readonly reset: string }
  | { readonly undo: true }
  | { readonly redo: true }
  // [LAW:effects-at-boundaries] The doctor (brandon-doctor-b6a): `run` folds
  // every check over the session's recorded client facts and writes the
  // report into SessionState; `fix` performs the repair the named check's
  // fresh verdict carries. `check` is a name in `CHECKS` (src/doctor/checks.ts)
  // — a load error otherwise — so the URL carries nothing the daemon has not
  // already declared. No `set`, so no validator derives (like copy/open).
  | { readonly doctor: "run" }
  | { readonly doctor: "fix"; readonly check: string }
  | DualActionDecl;

// [LAW:one-source-of-truth] The key whose PRESENCE makes an action
// dual-destination, and whose VALUE names the SessionState key that chooses
// the destination at click time. Spelled once: the loader dispatches on it,
// the compiler reads it, and the settings menu's synthesis writes it.
export const PERSIST_WHEN = "persistWhen";

// [LAW:types-are-the-program] ONE setting, ONE control, TWO stores
// (candybar-settings-ui-aok.3). Before this arm, a setting with both a
// session and a durable half cost the author two declarations and the reader
// two controls — `{{ menu "applyTheme" }}` beside `📌{{ menu
// "applyThemeForever" }}` — a second representation of one setting that had
// to be reconciled at every glance.
//
// A dual decl carries BOTH destination keys (`set` = the SessionState key,
// `persist` = the config-file key — they differ where history made them
// differ, e.g. session "theme" over globals field "palette") and ONE value
// source shared by both. `persistWhen` names the session key whose boolean
// value SELECTS the destination; the value written is identical either way,
// so the destination is the only thing that varies, and it varies as DATA
// [LAW:dataflow-not-control-flow].
//
// [LAW:single-enforcer] This adds NO gate surface. `actionDestinations`
// below explodes one dual decl into exactly the two single-destination decls
// it is equivalent to, and both validator derivations (state-validators.ts,
// config-validators.ts) fold over that explosion — so the writable (key,
// spec) pairs stay statically enumerable from the declarations, derived by
// the same code that has always derived them.
//
// The `int` / `removeSegment` / `insertSegment*` sources are deliberately
// absent: `int` is a UI-only page cursor with no durable meaning, and the
// structural edits are persist-only by design (see the arms above), so
// neither has two destinations to choose between.
export type DualActionDecl =
  | {
      readonly set: string;
      readonly persist: string;
      readonly persistWhen: string;
      readonly to: string;
    }
  | {
      readonly set: string;
      readonly persist: string;
      readonly persistWhen: string;
      readonly from: OptionDomain;
    }
  | {
      readonly set: string;
      readonly persist: string;
      readonly persistWhen: string;
      readonly cycle: readonly string[];
    }
  | {
      readonly set: string;
      readonly persist: string;
      readonly persistWhen: string;
      readonly min: number;
      readonly max: number;
      readonly by: number;
    };

// [LAW:parse-dont-validate] The one discriminator for the dual arm, and the
// reason every `"set" in a` consumer stays correct: a dual decl carries both
// `set` and `persist`, so a consumer that must treat the two destinations
// separately asks THIS first (or folds through actionDestinations below), and
// a consumer that only asks "does this bind a session write" (actionBindsSet)
// keeps its existing answer with no change at all.
export function actionIsDual(a: ActionDecl): a is DualActionDecl {
  return PERSIST_WHEN in a;
}

// [LAW:one-source-of-truth] THE explosion of an action into the
// single-destination declarations it writes through — `[a]` for every
// ordinary action, `[session, durable]` for a dual. Every consumer that
// reasons about DESTINATIONS (both validator derivations) flatMaps through
// this instead of learning the dual shape, so the gate a dual derives is by
// construction the union of the gates its two halves would have derived
// separately — there is no second derivation to keep in agreement.
export function actionDestinations(a: ActionDecl): readonly ActionDecl[] {
  if (!actionIsDual(a)) return [a];
  // [LAW:types-are-the-program] Written out per value source rather than
  // spread-and-cast: the two halves are then ordinary, fully-typed `set` and
  // `persist` members — the exact declarations an author would have written —
  // and adding a value source to DualActionDecl fails to compile here until
  // its explosion is stated.
  if ("to" in a) {
    return [
      { set: a.set, to: a.to },
      { persist: a.persist, to: a.to },
    ];
  }
  if ("from" in a) {
    return [
      { set: a.set, from: a.from },
      { persist: a.persist, from: a.from },
    ];
  }
  if ("cycle" in a) {
    return [
      { set: a.set, cycle: a.cycle },
      { persist: a.persist, cycle: a.cycle },
    ];
  }
  return [
    { set: a.set, min: a.min, max: a.max, by: a.by },
    { persist: a.persist, min: a.min, max: a.max, by: a.by },
  ];
}

// [LAW:dataflow-not-control-flow] Does this action write a SessionState key? A
// `set` action composes a set-state click URL whose first segment is session.id;
// copy/open/persist/reset embed none. One predicate the loader's session.id
// requirement folds over — no per-arm branching at the callsite.
export function actionBindsSet(a: ActionDecl): boolean {
  return "set" in a;
}

// [LAW:dataflow-not-control-flow] Does this action write the config file?
// Mirrors actionBindsSet for the `persist` arm.
export function actionBindsPersist(a: ActionDecl): boolean {
  return "persist" in a;
}

// [LAW:dataflow-not-control-flow] Does this action delete a config-file
// key? `reset` carries session.id on the wire too (for click-error surfacing,
// same as set/persist), so it joins the same requirement.
export function actionBindsReset(a: ActionDecl): boolean {
  return "reset" in a;
}

// [LAW:dataflow-not-control-flow] Does this action step the config-edit
// history? `undo`/`redo` carry session.id on the wire too — same reason as
// `reset`: an empty stack is a loud, session-scoped click.error, not a
// silent no-op (the ticket's own done-gate).
export function actionBindsUndo(a: ActionDecl): boolean {
  return "undo" in a;
}
export function actionBindsRedo(a: ActionDecl): boolean {
  return "redo" in a;
}

// [LAW:dataflow-not-control-flow] Does this action run or fix the doctor? Both
// doctor verbs carry session.id first on the wire (the report is written into
// that session's state, and a failure surfaces there), so it joins the same
// session.id requirement the others do.
export function actionBindsDoctor(a: ActionDecl): boolean {
  return "doctor" in a;
}
