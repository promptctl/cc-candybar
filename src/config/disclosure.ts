// [LAW:one-source-of-truth] THE disclosure primitive: the one toggle machinery
// that both group sugar (`kind: "group"`, src/config/loader/layout.ts) and the
// `{{ menu }}` helper (src/config/loader/menu-synth.ts + src/render/menu.ts) are
// built on. A disclosure is a binary toggle over a SessionState key: the key
// holds either the CLOSED sentinel or a single MEMBER name; a `cycle` action
// flips between the two; a ▸/▾ glyph shows which state it is in; sibling
// disclosures sharing one key become mutually exclusive (an accordion) because
// one key holds one open member. Group and menu differ ONLY in their BODY (group
// reveals an arbitrary layout container gated by a `when`; menu drops a picker
// grid below the row) and in where the trigger lives (group synthesizes a toggle
// segment; the menu helper IS the trigger). The toggle itself — sentinel, glyphs,
// the `state` var, the `cycle` action — is single-sourced HERE so the two
// body-kinds cannot drift [LAW:one-type-per-behavior][LAW:decomposition].
//
// [LAW:one-way-deps] This module is intentionally PURE — it imports only decl
// TYPES (erased at build) and holds no loader (`ValidateCtx`, diagnostics) nor
// render (rich-js) dependency, so both the loader synthesis passes and the render
// helper can share it without dragging one layer into the other. The loader-side
// reserved-namespace collision check — the other half of the shared machinery,
// which needs the validation context — lives in
// `src/config/loader/reserved-namespace.ts`.

import type { ActionDecl } from "./action.js";
import type { VariableDecl } from "./dsl-types.js";

// The "nothing open" sentinel a disclosure's key starts from and returns to on
// close. A disclosure's MEMBER (a group name / a menu apply-action name) may
// never equal this — an equal member would make the cycle `[closed, "closed"]`
// (two identical members, never openable), which both synthesis passes reject.
export const DISCLOSURE_CLOSED = "closed";

// [LAW:representation] The disclosure glyph vocabulary — one pair for the whole
// bar so every disclosure reads the same (trailing the label/content it gates,
// per pdu.8): collapsed ▸, expanded ▾.
//
// [LAW:one-source-of-truth] These are the AUTHORED default, never an emission.
// Every disclosure splices them into the template it synthesizes — group sugar
// (loader/layout.ts), the settings menu (settings-menu.ts), the bundled drawer
// — and a hand-authored config writes whichever glyph it likes, because the
// trigger's text is a display bound at the call site like any other. Until
// candybar-settings-ui-aok.4 `{{ menu }}` was the exception, appending ▸/▾ from
// its own runtime where no author could see or decline it, which is how edit
// mode's `+` came to render `+▸`.
export const DISCLOSURE_GLYPH_CLOSED = "▸";
export const DISCLOSURE_GLYPH_OPEN = "▾";

// [LAW:one-source-of-truth] The glyph that CLOSES an open disclosure. The
// picker body's ✕ has always been this; it lives here now because a trigger can
// wear it too — edit mode's `+` does, since a `+` whose only open-state cue was
// the ▸ this change removed would otherwise be indistinguishable from its
// siblings (three insertion points render byte-identically when one is open,
// and their dropped bodies are identical too, so row 0 is the only place the
// answer can live). Two affordances, one meaning, one glyph.
export const DISCLOSURE_GLYPH_CLOSE = "✕";

// [LAW:single-enforcer] THE display rule every multi-state trigger obeys: bind
// one display per member, or ONE static display that shows in every state. It
// lives here, beside the toggle machinery, because both disclosure kinds need
// it at different times — the loader can count a call's arguments statically
// and wants an ISSUE to report, the renderer holds the evaluated displays and
// wants to THROW — and a rule spelled once in each place is a rule that drifts.
// A `{{ menu }}` folds through it with two members (its `[closed, member]`
// cycle) and a cycle `{{ action }}` with as many as it declares; nothing about
// the rule is disclosure-specific beyond who calls it.
export function cycleDisplayIssue(
  subject: string,
  count: number,
  members: number,
): string | undefined {
  if (count === 0) return `${subject} needs a display (the clickable text)`;
  if (count !== 1 && count !== members) {
    return `${subject} cycles ${members} members; bind one display per member (${members}) or one static display, got ${count}`;
  }
  return undefined;
}

// [LAW:dataflow-not-control-flow] Which display shows is a pure function of
// (bound displays, current member index): a single static display shows in
// every state, per-member displays index by the state. Throws the one rule's
// text rather than silently dropping or repeating an argument.
export function pickCycleDisplay(
  subject: string,
  displays: readonly string[],
  members: number,
  index: number,
): string {
  const issue = cycleDisplayIssue(subject, displays.length, members);
  if (issue !== undefined) throw new Error(issue);
  return displays.length === 1 ? displays[0]! : displays[index]!;
}

// [LAW:one-source-of-truth] Go-template string-literal escaping for any DISPLAY
// text a synthesis splices INSIDE a quoted `{{ }}` argument of a template it
// emits — a group's label, a preset name in the reset banner, a `(?)` trigger's
// closed/open glyphs. NOT for a template's own body text, which is source rather
// than a splice: a help line is assigned verbatim (help.ts) because escaping one
// would put a backslash on the bar. It lives here, beside the two splices
// that need it most, because it was already two verbatim copies (loader/layout.ts
// and edit-chrome.ts, whose comment deferred the merge until "one small rule"
// earned its own home). The `(?)` affordance was the third caller, so it did.
export function escapeTemplateLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// [LAW:types-are-the-program] One open disclosure, named by the two strings that
// decide it: the VARIABLE a body reads and the MEMBER value that means "this one
// is open". They are distinct because a group's variable is per-group
// (`groups.<name>`) while its state KEY may be shared with accordion siblings —
// so the pair, never a lone key, is what identifies an open state.
export interface DisclosureRef {
  readonly variable: string;
  readonly member: string;
}

// [LAW:single-enforcer] THE body predicate a disclosure implies. Variadic
// because nesting is conjunction and nothing else: a row inside two disclosures
// is open when both are, which is one list, not a compound spelling. Callers
// that used to hand-write `{{ eq .x "open" }}` beside `{{ and (eq .x "open")
// (eq .y "open") }}` now pass one ref or two to one function — the shape stops
// varying with the depth [LAW:dataflow-not-control-flow].
//
// `and` is variadic in Go templates and returns its sole argument when given
// one, so the single-disclosure case needs no separate spelling.
//
// [LAW:types-are-the-program] The first ref is a separate parameter so a gate
// over ZERO disclosures — which would emit an argument-less `{{ and }}` and gate
// on nothing — is unrepresentable, with no runtime guard to state it.
export function disclosureGate(
  first: DisclosureRef,
  ...rest: readonly DisclosureRef[]
): string {
  const terms = [first, ...rest].map(disclosureTerm).join(" ");
  return `{{ and ${terms} }}`;
}

// [LAW:one-source-of-truth] THE spelling of "this disclosure is open" as one
// term of a larger predicate. `disclosureGate` is the all-disclosures case;
// a gate that conjoins a disclosure with a NON-disclosure fact (edit-chrome's
// banner: edit mode open AND the preset customized) composes this same term
// rather than re-spelling `eq` beside a second copy of the escaping.
export function disclosureTerm(ref: DisclosureRef): string {
  return `(eq .${ref.variable} "${escapeTemplateLiteral(ref.member)}")`;
}

// [LAW:single-enforcer] THE trigger template a disclosure's toggle segment
// carries: one `{{ action }}` over the cycle action, binding the author's text
// per state — closed first, matching the cycle's own closed-first member order
// so the display index and the member index are the same number. Since .4 every
// trigger authors its own text (the runtime appends no glyph), which makes this
// the one place the binding is spelled; before it, five sites spelled it and the
// `+▸` double-glyph bug lived in the gap between two of them.
export function disclosureTrigger(
  action: string,
  closed: string,
  open: string,
): string {
  return `{{ action "${action}" "${escapeTemplateLiteral(closed)}" "${escapeTemplateLiteral(open)}" }}`;
}

// [LAW:single-enforcer] THE backing `state` variable a disclosure key implies:
// it holds the open member's name and defaults to `def` (the CLOSED sentinel for
// an independent disclosure, or an initially-open member for a group's
// `open: true`). One shape, so a group var and a menu var declared on one key
// cannot disagree on kind or key.
export function disclosureStateVar(key: string, def: string): VariableDecl {
  return { kind: "state", key, default: def };
}

// [LAW:single-enforcer] THE toggle action a disclosure realizes: a binary `cycle`
// between the CLOSED sentinel and the member (ordered closed-first, so an unset or
// sibling-held key counts as the first member — the toggle renders ▸ and a click
// writes the member, opening it and auto-closing any accordion sibling). The
// derived click gate (`deriveActionValidators`) reads this like every other
// `set`, so a disclosure toggle needs no parallel verb [LAW:single-enforcer].
export function disclosureCycleAction(key: string, member: string): ActionDecl {
  return { set: key, cycle: [DISCLOSURE_CLOSED, member] };
}
