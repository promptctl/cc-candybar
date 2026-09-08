// [LAW:one-source-of-truth] The TOGGLE half of edit mode: this pass synthesizes only
// the state and toggle action, so a hand-authored `{{ action "edit.toggle" }}`
// compiles like any other action. The per-segment +/- chrome is a later pass that
// needs the merged, preset-resolved tree. [LAW:carrying-cost] Synthesis is
// DEMAND-DRIVEN: any state var or set action forces cross-ref to require a global
// `session.id`, so synthesizing unconditionally would impose it on every static bar.

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

// [LAW:one-source-of-truth] The reserved namespace every edit-mode artifact uses.
export const EDIT_NS = "edit.";

// [LAW:single-enforcer] One declaration of edit mode's key and toggle identity.
export const EDIT_MODE_KEY = "edit.mode";
export const EDIT_TOGGLE_ACTION = "edit.toggle";
export const EDIT_MODE_OPEN = "open";

// [LAW:one-source-of-truth] As a ref, anything nested inside can conjoin this gate.
export const EDIT_MODE_REF: DisclosureRef = {
  variable: EDIT_MODE_KEY,
  member: EDIT_MODE_OPEN,
};

// [LAW:one-source-of-truth] Derived from the ref, so chrome and a group body share
// one rule rather than two spellings that agree today.
export const EDIT_MODE_GATE = disclosureGate(EDIT_MODE_REF);

// [LAW:single-enforcer] The ONE detector for "does this file want edit mode": an
// AST match, robust against whitespace and lookalike text a string scan would get
// wrong. The engine never evaluates, so a malformed template just yields no match.
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
