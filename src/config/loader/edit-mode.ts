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
// [LAW:carrying-cost] DEMAND-DRIVEN, not unconditional — this is the one place
// this pass diverges from group/menu synthesis's OWN precedent of "reserve
// unconditionally, synthesize on demand" and leans fully into the "on demand"
// half: a config that references `{{ action "edit.toggle" … }}` nowhere gets
// NEITHER the toggle var/action NOR (edit-chrome.ts checks for the SAME
// action's presence) any per-segment chrome. This matters concretely, not just
// as a purity concern — `edit.mode` is a `state` variable and `edit.toggle` is
// a `set` action, and cross-ref.ts requires a global `session.id` variable the
// instant ANY state var or set action exists anywhere in a config. Synthesizing
// either unconditionally would force session.id onto every purely-static,
// non-interactive bar in the corpus — exactly the regression an early version
// of this pass caused. The reserved namespace stays reserved unconditionally
// (mirroring reservedNamespaceCollisions' own contract); only the SYNTHESIS is
// conditional.
//
// WHAT candybar-settings-ui-aok.1 CHANGED, and what it did not: the gate above
// is intact and still the only way edit mode is reached — but it now has a
// PERMANENT DEMANDER. synthesizeSettingsMenu mints a `settings.edit` segment
// referencing `edit.toggle` into every config it can host, so in practice the
// demand is satisfied for essentially every config a user writes, and reading
// this section as "most bars carry no edit mode" is no longer true. The
// separation the gate protects still holds exactly where it always mattered:
// the menu declines to synthesize for a config with no `session.id`
// (canHostSessionState in settings-menu.ts), which is precisely the static,
// non-interactive bar this comment was written to keep clean. Production blast
// radius was nil either way — the bundled default's `toolbar` segment already
// referenced `edit.toggle`, so every config merging it already demanded edit
// mode before the menu existed.

import { createEngine } from "@promptctl/go-template-js";
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
import { reservedNamespaceCollisions } from "./reserved-namespace.js";

// [LAW:one-source-of-truth] The reserved namespace every edit-mode artifact —
// this toggle AND edit-chrome.ts's per-position +/- actions/segments — lives
// under, mirroring `groups.`/`menus.`. Exported so edit-chrome.ts's LATER
// synthesis (and its `isChromeExempt` exclusion of edit-mode's own chrome
// from being treated as ordinary, removable/addable content) reads the same
// string, never a second copy.
export const EDIT_NS = "edit.";

// [LAW:single-enforcer] The SessionState key edit mode's on/off state lives
// at, and the toggle action's identity member. Both edit-chrome.ts (every
// synthesized affordance's `when` gate) and a hand-authored trigger segment
// read/write these same two names — one declaration, no drift.
export const EDIT_MODE_KEY = "edit.mode";
export const EDIT_TOGGLE_ACTION = "edit.toggle";
export const EDIT_MODE_OPEN = "open";

// [LAW:one-source-of-truth] Edit mode AS a disclosure, which is what it has
// always been: a binary toggle over one SessionState key. Naming it as a ref
// lets anything nested inside edit mode (a `(?)` and its body) derive its own
// gate by conjunction with this one, instead of concatenating gate strings.
export const EDIT_MODE_REF: DisclosureRef = {
  variable: EDIT_MODE_KEY,
  member: EDIT_MODE_OPEN,
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
// or false-negative on), one function name over. A bare engine purely for
// introspection: it never evaluates, so a malformed template simply yields
// no match here (registerDslConfig re-parses and reports the real error;
// [LAW:no-silent-failure] this pass just isn't the one that reports it).
function referencesEditToggle(template: string): boolean {
  const engine = createEngine<string>({ fromString: (s) => s });
  try {
    return engine
      .parse(template)
      .referencedCalls()
      .some((c) => c.name === "action" && c.args[0] === EDIT_TOGGLE_ACTION);
  } catch {
    return false;
  }
}

function fileWantsEditMode(out: Readonly<RawDslConfig>): boolean {
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
    [EDIT_TOGGLE_ACTION]: disclosureCycleAction(EDIT_MODE_KEY, EDIT_MODE_OPEN),
  };
  out.variables = { ...(out.variables ?? {}), ...variables };
  out.actions = { ...(out.actions ?? {}), ...actions };
}
