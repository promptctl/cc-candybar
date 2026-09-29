// [LAW:one-source-of-truth] What a synthesis pass depends on rather than owns.
// The settings menu and edit chrome mint segments, actions and variables into
// every config (brandon-settings-menu-d6f), and those artifacts read payload
// inputs the config may not declare. Each pass hands over its artifacts and the
// subtrees it minted (never the author's tree it splices them into, whose reads
// are cross-ref's to check) and gets back the declarations to merge UNDER the
// config. They are derived from what the artifacts read, never a hand-kept
// list, so a read a later control adds is ensured with no second place to
// update.

import type { ActionDecl } from "./action.js";
import {
  walkNodes,
  type LayoutNode,
  type SegmentDecl,
  type VariableDecl,
} from "./dsl-types.js";
import { extractTemplateRefs, refResolves } from "./loader/refs.js";
import { PAYLOAD_INPUTS } from "./payload-inputs.js";
import {
  CONFIG_KEY_TO_EFFECTIVE_VAR,
  SESSION_KEY_TO_EFFECTIVE_VAR,
} from "./setting-projections.js";
import { SESSION_ID_VAR_NAME } from "../var-system/sources.js";

export interface SynthesisArtifacts {
  readonly variables: Readonly<Record<string, VariableDecl>>;
  readonly actions: Readonly<Record<string, ActionDecl>>;
  readonly segments: Readonly<Record<string, SegmentDecl>>;
}

// Every variable the artifacts READ. Three kinds of read: the dotted refs of
// every template (segment fields, node `when`s, template variables, copy/open
// actions); session.id, which realizing any action reads for the click's
// first wire segment (render/action.ts), so a pass that mints an action reads
// it; and the `.effective` projection a `set` or `persist` on a setting reads
// its current value back through (registerDslConfig's stateKeyToVar,
// CONFIG_KEY_TO_EFFECTIVE_VAR).
function synthesisReads(
  artifacts: SynthesisArtifacts,
  trees: readonly LayoutNode[],
): Set<string> {
  const reads = new Set<string>();
  const add = (template: string | undefined): void => {
    for (const ref of extractTemplateRefs(template ?? "")) reads.add(ref);
  };
  for (const seg of Object.values(artifacts.segments)) {
    add(seg.template);
    add(seg.bg);
    add(seg.fg);
    add(seg.when);
  }
  for (const tree of trees) {
    for (const node of walkNodes(tree)) add(node.when);
  }
  for (const v of Object.values(artifacts.variables)) {
    if (v.kind === "template") add(v.template);
  }
  const actions = Object.values(artifacts.actions);
  if (actions.length > 0) reads.add(SESSION_ID_VAR_NAME);
  for (const a of actions) {
    if ("copy" in a) add(a.copy);
    if ("open" in a) add(a.open);
    const setBack =
      "set" in a ? SESSION_KEY_TO_EFFECTIVE_VAR.get(a.set) : undefined;
    const persistBack =
      "persist" in a ? CONFIG_KEY_TO_EFFECTIVE_VAR.get(a.persist) : undefined;
    if (setBack !== undefined) reads.add(setBack);
    if (persistBack !== undefined) reads.add(persistBack);
  }
  return reads;
}

// [LAW:no-silent-failure] The declarations for every read that neither the
// artifacts nor `declared` (the names the config already holds) resolve,
// supplied from the one PAYLOAD_INPUTS table. A read the table cannot supply
// is a defect in the synthesis — its chrome would render a ⚠ in every config
// that lacks the name — so it throws at load, naming the ref, rather than
// minting a guess.
export function synthesisInputs(
  artifacts: SynthesisArtifacts,
  trees: readonly LayoutNode[],
  declared: Iterable<string>,
): Record<string, VariableDecl> {
  const own = {
    names: new Set([...declared, ...Object.keys(artifacts.variables)]),
    documents: new Set<string>(),
  };
  const ensured: Record<string, VariableDecl> = {};
  for (const ref of synthesisReads(artifacts, trees)) {
    if (refResolves(ref, own)) continue;
    const decl = PAYLOAD_INPUTS[ref];
    if (decl === undefined) {
      throw new Error(
        `synthesized chrome reads ".${ref}", which it does not declare and PAYLOAD_INPUTS does not supply`,
      );
    }
    ensured[ref] = decl;
  }
  return ensured;
}
