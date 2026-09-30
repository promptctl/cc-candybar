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
// static lists, "styles" is the one PER-CONFIG domain (the merged `looks`
// block's names, threaded as data rather than consulted from a module
// constant), and an inline array is its own domain, needing no registration
// at all. Re-exported here so ActionDecl stays self-contained to read.
import type { OptionDomain } from "./option-domain.js";
import type { SlashLine } from "../claude-input/slash-line.js";
export type { OptionDomain } from "./option-domain.js";

// [LAW:types-are-the-program] The top-level discriminator of an ActionDecl — the
// click effect is keyed by which of these is present. The loader proves
// exactly-one-of; the renderer and validator-derivation match with no fallthrough.
//
// [LAW:one-source-of-truth] `persist` is `set`'s PERSISTENT twin: `set`
// mutates per-session SessionState, `persist` mutates the config's DEFAULT
// by writing the config FILE itself (candybar-config-dqe — the one durable
// store; the write splices the value in place so the file's comments
// survive). `reset` returns that key to its bundled default — its paths in
// the file and the session's pick (resetLayers) — the gated way back a
// machine write needs, since one with no way back would be a one-way ratchet.
//
// [LAW:one-source-of-truth] `undo`/`redo` (brandon-layout-edit-2gc.2) are
// `reset`'s FINE-GRAINED siblings: `reset` returns one named key to the
// bundled default outright (the coarse "forget this setting" case); `undo`/`redo` step the session's
// history of every settings change — session picks and config-file writes
// alike — back and forth. Neither carries a key: the history is one stack per
// session (src/daemon/settings-history.ts), so the action is a bare marker,
// like `int: true` is for a set-int cursor. `save` is the third marker: it
// writes every setting the session holds unsaved (src/daemon/setting-drafts.ts)
// to the config file, and the daemon — not the click — knows which they are.
export const ACTION_KEYS = [
  "set",
  "persist",
  "copy",
  "open",
  "reset",
  "undo",
  "redo",
  "save",
  "preset",
  "doctor",
  "ceiling",
  "slash",
  "do",
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
//   undo                — step the session's settings history one
//                         click back (a session pick or any persist/reset/
//                         layout write) -> no gate, no key: there is nothing a
//                         template could smuggle, since the value restored is
//                         whatever the daemon's own history recorded, never
//                         wire input
//   redo                — the inverse of undo: re-apply the most recently
//                         undone step -> no gate, no key
//   save                — write every unsaved setting to the config file and
//                         release it from the session -> no gate of its own:
//                         each value re-crosses the session gate that admitted
//                         it, and no value rides the wire
//   preset: "save"      — write the bar the session renders into the config
//                         file as a new preset and switch to it -> no gate of
//                         its own: its values re-cross the session gate
//   preset: "delete"    — delete the preset `name` (a template, evaluated at
//     + name              render) from the config file -> no gate of its own:
//                         the daemon refuses a bundled preset or one the file
//                         does not declare
//   slash               — type the declared slash command into this
//                         session's Claude Code prompt -> no gate: the verb
//                         honours only lines the config declares
//   do                  — fire several declared actions in one click: the
//                         first is the click's face (its display rule and
//                         current-state mark are the region's), the rest ride
//                         along -> no gate of its own: every member is a
//                         declared action whose gate is already derived
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
  | { readonly save: true }
  // Save as preset (brandon-save-undo-bwi.o6u). `save` takes nothing — the
  // daemon names the preset and reads what it holds at click time — while
  // `delete` names its preset by a template, like `copy`'s text, so one
  // declaration serves "delete the preset I am in" and "delete this one".
  | { readonly preset: "save" }
  | { readonly preset: "delete"; readonly name: string }
  // [LAW:effects-at-boundaries] The doctor (brandon-doctor-b6a): `run` folds
  // every check over the session's recorded client facts and writes the
  // report into SessionState; `fix` performs the repair the named check's
  // fresh verdict carries. `check` is a name in `CHECKS` (src/doctor/checks.ts)
  // — a load error otherwise — so the URL carries nothing the daemon has not
  // already declared. No `set`, so no validator derives (like copy/open).
  | { readonly doctor: "run" }
  | { readonly doctor: "fix"; readonly check: string }
  // [LAW:one-source-of-truth] The memento plugin's context ceiling for the
  // clicked session: `set` hands `to` — memento's own value grammar, `+100_000`
  // / `400000` / `off` — to memento's `ceiling set session`, `clear` removes
  // the session's layer. Nothing here parses `to`: memento is the one judge
  // of its grammar, and refuses at the click (src/memento/edge.ts). The
  // declared moves are also the verb's allow-list, so a URL can make only the
  // moves the session's config offers.
  | { readonly ceiling: "set"; readonly to: string }
  | { readonly ceiling: "clear" }
  // [LAW:parse-dont-validate] Type a slash command into the clicked session's
  // Claude Code prompt (src/claude-input/edge.ts). The line is a `SlashLine`,
  // proved at load, and a click is honoured only as a line some declared
  // `slash` action holds, so a URL cannot make up what gets typed.
  | { readonly slash: SlashLine }
  // [LAW:composability] One click, several effects, built from actions that
  // already exist rather than from a new write vocabulary: entering edit mode
  // and closing the menu it was entered from is `edit.toggle` and a close,
  // named together. The tuple type states the one structural fact — there is
  // always a head, the member whose display the region shows.
  | { readonly do: readonly [string, ...string[]] };

export type CeilingAction = Extract<ActionDecl, { readonly ceiling: string }>;
export type SlashAction = Extract<ActionDecl, { readonly slash: string }>;

// [LAW:one-source-of-truth] A ceiling move as the click wire carries it after
// the session id — the one spelling the renderer emits and the verb compares
// a click against the config's declared moves with.
export function ceilingMoveArgs(a: CeilingAction): readonly string[] {
  return a.ceiling === "set" ? ["set", a.to] : ["clear"];
}

// [LAW:types-are-the-program] Does this action take the value it writes from
// the TEMPLATE (a picker's bound option, a cursor's integer)? Such an action
// cannot ride behind a `do` head: only the head is bound a display, so a
// follower would write the head's display as its own value. The loader asks
// this of every follower (cross-ref.ts), so the case is a load error rather
// than a wrong write.
export function actionBindsTemplateValue(a: ActionDecl): boolean {
  return "from" in a || "int" in a || "insertSegmentFrom" in a;
}
