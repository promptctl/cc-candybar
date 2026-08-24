// [LAW:one-source-of-truth] brandon-layout-edit-2gc.3's TOGGLE half of edit
// mode — the disclosure primitive's third body-kind, one register down from
// group sugar and `{{ menu }}`: where those two synthesize a whole trigger +
// body, edit mode synthesizes only the on/off state + toggle ACTION here
// (`edit.mode` / `edit.toggle`), so a hand-authored `{{ action "edit.toggle"
// "✎" }}` cross-ref-checks and compiles exactly like any other action — no
// bespoke "this action always exists" carve-out anywhere downstream. The
// per-segment +/- CHROME is a separate, LATER pass
// (src/config/edit-chrome.ts) that runs on the fully merged, preset-resolved,
// rootOps-replayed config (inside validateConfig, not here) because it needs
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

import { createEngine } from "@promptctl/go-template-js";
import type { Mutable, ValidateCtx } from "./validate-core.js";
import type { RawDslConfig, VariableDecl } from "../dsl-types.js";
import type { ActionDecl } from "../action.js";
import {
  DISCLOSURE_CLOSED,
  disclosureCycleAction,
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

// [LAW:one-source-of-truth] The predicate every synthesized +/- chrome
// segment gates on — spelled once here so edit-chrome.ts never hand-rolls
// the template string a second time.
export const EDIT_MODE_GATE = `{{ eq .${EDIT_MODE_KEY} "${EDIT_MODE_OPEN}" }}`;

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
