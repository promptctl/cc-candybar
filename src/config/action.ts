// [LAW:types-are-the-program] The author-facing SHAPE of a named ACTION: pure data.
// [LAW:locality-or-seam] An action is the SEAM between the clickable
// REPRESENTATION and the BEHAVIOR, joined by NAME. [LAW:one-source-of-truth] A set
// carries its value SOURCE as data, so the writable-key gate DERIVES from this
// table — a template names an action; it cannot smuggle an un-gated write.

// [LAW:one-source-of-truth] Re-exported so ActionDecl stays self-contained to read.
import type { OptionDomain } from "./option-domain.js";
export type { OptionDomain } from "./option-domain.js";

// [LAW:types-are-the-program] The top-level discriminator: which key is present.
// [LAW:one-source-of-truth] `set` mutates per-session SessionState, `persist` the
// config FILE (spliced in place, so comments survive), `reset` deletes that key.
// `undo`/`redo` step whole-file snapshots and carry no key — one stack per file.
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

// [LAW:types-are-the-program] A `set`/`persist` is sub-discriminated by its value
// SOURCE, and each source IS its gate: `to` → allow-list {to}; `from` → the option
// the template binds, allow-list {options}; `min/max/by` → wrap(current ± by) over
// a range; `int` → any integer, the paged cursor no bounded arm can express;
// `cycle` → the successor of the current value, wrapping, a value outside the
// domain counting as the first member. [LAW:one-type-per-behavior] `persist`
// mirrors those minus `int`, and owns the structural edits alone.
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
  // [LAW:one-source-of-truth] The DOMAIN-SOURCED sibling of `insertSegment` — the
  // `to`-vs-`from` split one arm over. `anchor`/`relation` stay author-time data;
  // only WHICH segment lands there is picked at render, and the click emits the
  // same wire shape, so undo/redo and the apply handler need no change.
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
  // [LAW:effects-at-boundaries] `check` must name a member of CHECKS — a load
  // error otherwise — so the URL carries nothing the daemon has not declared.
  | { readonly doctor: "run" }
  | { readonly doctor: "fix"; readonly check: string }
  | DualActionDecl;

// [LAW:one-source-of-truth] The key whose PRESENCE makes an action dual, and whose
// VALUE names the session key that chooses the destination at click time.
export const PERSIST_WHEN = "persistWhen";

// [LAW:types-are-the-program] ONE setting, ONE control, TWO stores: a dual carries
// BOTH destination keys and ONE shared value source, and `persistWhen` names the
// session key whose boolean SELECTS the destination — so only the destination
// varies, as DATA. `int` and the structural edits have no second destination.
// [LAW:single-enforcer] It adds no gate surface: actionDestinations explodes it.
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

// [LAW:parse-dont-validate] THE discriminator: a dual carries both `set` and
// `persist`, so a consumer needing the two destinations apart asks this first.
export function actionIsDual(a: ActionDecl): a is DualActionDecl {
  return PERSIST_WHEN in a;
}

// [LAW:one-source-of-truth] THE explosion into single-destination declarations, so
// a dual's gate is by construction the union of the gates its two halves derive.
export function actionDestinations(a: ActionDecl): readonly ActionDecl[] {
  if (!actionIsDual(a)) return [a];
  // [LAW:types-are-the-program] Written out per value source rather than
  // spread-and-cast, so a new source fails to compile until its explosion exists.
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

// [LAW:dataflow-not-control-flow] One predicate the loader's session.id
// requirement folds over — no per-arm branching at the callsite.
export function actionBindsSet(a: ActionDecl): boolean {
  return "set" in a;
}

export function actionBindsPersist(a: ActionDecl): boolean {
  return "persist" in a;
}

// `reset` carries session.id on the wire too, so it joins the same requirement.
export function actionBindsReset(a: ActionDecl): boolean {
  return "reset" in a;
}

// `undo`/`redo` carry session.id too: an empty stack is a loud, session-scoped
// click.error, not a silent no-op.
export function actionBindsUndo(a: ActionDecl): boolean {
  return "undo" in a;
}
export function actionBindsRedo(a: ActionDecl): boolean {
  return "redo" in a;
}

export function actionBindsDoctor(a: ActionDecl): boolean {
  return "doctor" in a;
}
