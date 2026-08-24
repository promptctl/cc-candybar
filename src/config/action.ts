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
// [LAW:one-source-of-truth] `persist` is `set`'s PERSISTENT twin
// (candybar-config-engine-71o.2): `set` mutates per-session SessionState,
// `persist` mutates the config's `globals` DEFAULT through the daemon-owned
// overrides layer (never the hand-authored config file). `reset` clears one
// persisted override — the gated undo `persist` needs, since a machine-owned
// write with no way back would be a one-way ratchet.
//
// [LAW:one-source-of-truth] `undo`/`redo` (brandon-layout-edit-2gc.2) are
// `reset`'s FINE-GRAINED siblings: `reset` clears one named key outright
// (the coarse "forget this override" case); `undo`/`redo` step ONE GLOBAL
// history of every `persist`/`reset` write ever made to the overrides layer
// — every key, not just structural layout edits — back and forth. Neither
// carries a key: the history is a single stack over the whole overrides
// file (config-overrides-store.ts owns it), so the action is a bare marker,
// like `int: true` is for a set-int cursor.
export const ACTION_KEYS = [
  "set",
  "persist",
  "copy",
  "open",
  "reset",
  "undo",
  "redo",
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
//   undo                — step the config-overrides layer's GLOBAL history one
//                         entry back (any persist/reset write, not just a
//                         layout op) -> no gate, no key: there is nothing a
//                         template could smuggle, since the value restored is
//                         whatever the daemon's own history recorded, never
//                         wire input
//   redo                — the inverse of undo: re-apply the most recently
//                         undone entry -> no gate, no key
//   removeSegment       — (persist only) remove the named segment from the
//                         preset-root the `persist` key addresses
//                         (`presets.<name>.rootOps`) -> allow-list {one op
//                         token — see src/config/layout-ops.ts}
//   insertSegment +
//     anchor + relation  — (persist only) insert a named segment before/after
//                         an existing one, same key shape -> allow-list {one
//                         op token}
//
// [LAW:one-source-of-truth] `set` writes SessionState and `persist` writes
// the config-overrides layer, so only those two derive a validator (through
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
// (brandon-layout-edit-2gc.1) — a structural edit is always a durable,
// machine-owned write by design (the ticket's own instruction: reuse 71o's
// writer, land in the SAME overrides layer), so there is no SessionState
// twin. Every operation is fully literal at config-author time — the
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
  | { readonly copy: string }
  | { readonly open: string }
  | { readonly reset: string }
  | { readonly undo: true }
  | { readonly redo: true };

// [LAW:dataflow-not-control-flow] Does this action write a SessionState key? A
// `set` action composes a set-state click URL whose first segment is session.id;
// copy/open/persist/reset embed none. One predicate the loader's session.id
// requirement folds over — no per-arm branching at the callsite.
export function actionBindsSet(a: ActionDecl): boolean {
  return "set" in a;
}

// [LAW:dataflow-not-control-flow] Does this action write the config-overrides
// layer? Mirrors actionBindsSet for the `persist` arm.
export function actionBindsPersist(a: ActionDecl): boolean {
  return "persist" in a;
}

// [LAW:dataflow-not-control-flow] Does this action clear a config-overrides
// key? `reset` carries session.id on the wire too (for click-error surfacing,
// same as set/persist), so it joins the same requirement.
export function actionBindsReset(a: ActionDecl): boolean {
  return "reset" in a;
}

// [LAW:dataflow-not-control-flow] Does this action step the config-overrides
// history? `undo`/`redo` carry session.id on the wire too — same reason as
// `reset`: an empty stack is a loud, session-scoped click.error, not a
// silent no-op (the ticket's own done-gate).
export function actionBindsUndo(a: ActionDecl): boolean {
  return "undo" in a;
}
export function actionBindsRedo(a: ActionDecl): boolean {
  return "redo" in a;
}
