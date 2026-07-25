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
export const DISCLOSURE_GLYPH_CLOSED = "▸";
export const DISCLOSURE_GLYPH_OPEN = "▾";

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
