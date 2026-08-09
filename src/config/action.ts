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
export const ACTION_KEYS = ["set", "copy", "open"] as const;
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
//
// [LAW:one-source-of-truth] Only `set` writes SessionState, so only `set`
// derives a validator. copy/open write nothing — they derive nothing. The
// vocabulary grows by arms (a future `run`/`open-url`), not by validator plumbing.
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
  | { readonly copy: string }
  | { readonly open: string };

// [LAW:dataflow-not-control-flow] Does this action write a SessionState key? A
// `set` action composes a set-state click URL whose first segment is session.id;
// copy/open embed none. One predicate the loader's session.id requirement folds
// over — no per-arm branching at the callsite.
export function actionBindsSet(a: ActionDecl): boolean {
  return "set" in a;
}
