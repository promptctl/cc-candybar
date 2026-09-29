// [LAW:one-source-of-truth] brandon-layout-edit-2gc.3's TOGGLE half of edit
// mode — the disclosure primitive's third body-kind, one register down from
// group sugar and `{{ menu }}`: where those two synthesize a whole trigger +
// body, edit mode synthesizes only the on/off state + toggle ACTION here
// (`edit.mode` / `edit.toggle`), so a hand-authored `{{ action "edit.toggle"
// "✎" }}` cross-ref-checks and compiles exactly like any other action — no
// bespoke "this action always exists" carve-out anywhere downstream. The
// per-segment +/- CHROME is a separate, LATER pass
// (src/config/edit-chrome.ts) that runs on the fully merged, preset-resolved
// config (inside validateConfig, not here) because it needs
// data — which segments are in which preset's CURRENT tree — that does not
// exist yet at this per-file parse stage. Splitting the two halves across two
// synthesis points is not incidental: the toggle is authorable/cross-ref-able
// content (like a group's name or a menu's apply action), the chrome is
// derived data (like a group's lowered body), and each belongs at the stage
// that has what it needs.
//
// [LAW:carrying-cost] Per FILE, the toggle is minted only where that file
// references it, so an authored `{{ action "edit.toggle" … }}` (or a `do`
// firing it) cross-ref-checks before the merged config exists. It is not what
// makes edit mode reachable: the settings menu is synthesized into every
// config (settings-menu.ts), ensures this same toggle, and puts `✎ edit` in its
// body, so every bar carries edit mode and edit chrome runs unconditionally.

import { SYNTAX_ENGINE } from "./syntax-engine.js";
import type { Mutable, ValidateCtx } from "./validate-core.js";
import type {
  DisclosureRef,
  RawDslConfig,
  VariableDecl,
} from "../dsl-types.js";
import type { ActionDecl } from "../action.js";
import {
  DISCLOSURE_CLOSED,
  disclosureCycleAction,
  disclosureGate,
  disclosureStateVar,
} from "../disclosure.js";
import { EDIT_NS, reservedNamespaceCollisions } from "./reserved-namespace.js";

// [LAW:single-enforcer] The SessionState key edit mode's state lives at, and
// the toggle action's identity member. Both edit-chrome.ts (every synthesized
// affordance's `when` gate) and a hand-authored trigger segment read/write
// these same names — one declaration, no drift.
//
// [LAW:types-are-the-program] ONE key holds which edit mode is on
// (brandon-segment-settings-i4n.g64): `closed`, `arrange` (the +/- chrome), or
// `configure:<id>` (one placement's settings). Configuring two placements at
// once, or configuring while arranging, is a second value this key would have
// to hold at the same time — unrepresentable, with nothing to check.
export const EDIT_MODE_KEY = "edit.mode";
export const EDIT_TOGGLE_ACTION = "edit.toggle";
export const EDIT_MODE_ARRANGE = "arrange";

// The namespace every placement's unsaved setting value lives under, as a
// session key and as a variable. No scalar is declared at `edit.draft`, so
// nothing under it can be shadowed by one — as a preset named `mode` would
// shadow `edit.mode.…` beside edit mode's own state.
export const PLACEMENT_DRAFT_NS = `${EDIT_NS}draft.`;

// The member that configures the placement `id` in the layout of the preset
// whose ident is `presetIdent` — an id is unique only within one preset's
// tree, so switching presets never carries configure mode onto a different
// placement that shares the id. Neither part holds a `:` (an ident is
// `[A-Za-z0-9_]`, and the loader refuses one in an id), so the member names
// exactly one placement.
export function configureMember(presetIdent: string, id: string): string {
  return `configure:${presetIdent}:${id}`;
}

// [LAW:one-source-of-truth] Edit mode AS a disclosure, which is what it has
// always been: a binary toggle over one SessionState key. Naming it as a ref
// lets anything nested inside edit mode (a `(?)` and its body) derive its own
// gate by conjunction with this one, instead of concatenating gate strings.
export const EDIT_MODE_REF: DisclosureRef = {
  variable: EDIT_MODE_KEY,
  key: EDIT_MODE_KEY,
  member: EDIT_MODE_ARRANGE,
};

// [LAW:one-source-of-truth] The predicate every synthesized +/- chrome
// segment gates on — derived from the ref above through the same function
// every other disclosure's gate comes from, so edit-mode chrome and a group
// body are gated by one rule rather than by two spellings that agree today.
export const EDIT_MODE_GATE = disclosureGate(EDIT_MODE_REF);

// [LAW:single-enforcer] The ONE detector for "does this file want edit mode":
// a literal `{{ action "edit.toggle" … }}` call somewhere a segment's
// template/bg/fg can reach — the SAME AST-based approach
// menu-synth.ts's segmentReferencesMenu uses (robust against whitespace,
// pipelines, and lookalike text a source-string scan would false-positive
// or false-negative on), one function name over. It never evaluates, so a
// malformed template simply yields no match here (registerDslConfig re-parses
// and reports the real error; [LAW:no-silent-failure] this pass just isn't
// the one that reports it).
function referencesEditToggle(template: string): boolean {
  try {
    return SYNTAX_ENGINE.parse(template)
      .referencedCalls()
      .some((c) => c.name === "action" && c.args[0] === EDIT_TOGGLE_ACTION);
  } catch {
    return false;
  }
}

// A file also wants edit mode when one of its `do` actions fires `edit.toggle`
// — a click that reaches the toggle without a template naming it.
function fileWantsEditMode(out: Readonly<RawDslConfig>): boolean {
  if (
    Object.values(out.actions ?? {}).some(
      (a) => "do" in a && a.do.includes(EDIT_TOGGLE_ACTION),
    )
  ) {
    return true;
  }
  for (const seg of Object.values(out.segments ?? {})) {
    for (const field of [seg.template, seg.bg, seg.fg] as const) {
      if (typeof field === "string" && referencesEditToggle(field)) {
        return true;
      }
    }
  }
  return false;
}

export function synthesizeEditModeToggle(
  ctx: ValidateCtx,
  out: Mutable<RawDslConfig>,
): void {
  reservedNamespaceCollisions(ctx, out, EDIT_NS, "edit mode");
  if (!fileWantsEditMode(out)) return;
  const variables: Record<string, VariableDecl> = {
    [EDIT_MODE_KEY]: disclosureStateVar(EDIT_MODE_KEY, DISCLOSURE_CLOSED),
  };
  const actions: Record<string, ActionDecl> = {
    [EDIT_TOGGLE_ACTION]: disclosureCycleAction(
      EDIT_MODE_KEY,
      EDIT_MODE_ARRANGE,
    ),
  };
  out.variables = { ...(out.variables ?? {}), ...variables };
  out.actions = { ...(out.actions ?? {}), ...actions };
}
