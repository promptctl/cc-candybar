// [LAW:one-source-of-truth] What a synthesis pass depends on rather than owns.
// The settings menu and edit chrome mint segments, actions and variables into
// every config (brandon-settings-menu-d6f), and those artifacts read payload
// inputs. Every merged config carries those, beneath everything authored (the
// merge lays them beneath every base), so a pass owns nothing it reads. Each pass hands over its artifacts and the trees it RETURNS — the
// author's nodes inside them included, whose reads cross-ref has already
// resolved against the same scope, so reading the trees the bar renders costs
// nothing and misses nothing the pass minted — and every read is checked
// against what the config and the artifacts declare. The reads are derived
// from the artifacts, never a hand-kept list, so a read a later control adds
// is checked with no second place to update.

import { actionTemplates, type ActionDecl } from "./action.js";
import {
  walkNodes,
  type DslConfig,
  type LayoutNode,
  type SegmentDecl,
  type VariableDecl,
} from "./dsl-types.js";
import { templateReads, refResolves, templateScopeOf } from "./loader/refs.js";
import {
  CONFIG_KEY_TO_EFFECTIVE_VAR,
  SESSION_KEY_TO_EFFECTIVE_VAR,
} from "./setting-projections.js";

export interface SynthesisArtifacts {
  readonly variables: Readonly<Record<string, VariableDecl>>;
  readonly actions: Readonly<Record<string, ActionDecl>>;
  readonly segments: Readonly<Record<string, SegmentDecl>>;
}

// Every variable the artifacts READ. Three kinds of read: the dotted refs of
// every template (segment fields, node `when`s and the lead/trail drawn in a
// segment node's cell, template variables, copy/open actions); and the
// `.effective` projection a
// `set` or `persist` on a setting reads its current value back through
// (registerDslConfig's stateKeyToVar, CONFIG_KEY_TO_EFFECTIVE_VAR).
function synthesisReads(
  artifacts: SynthesisArtifacts,
  trees: readonly LayoutNode[],
  helpers: Readonly<Record<string, string>>,
): Set<string> {
  const reads = new Set<string>();
  const add = (
    template: string | undefined,
    scope: Readonly<Record<string, string>> = helpers,
  ): void => {
    for (const ref of templateReads(template ?? "", scope).keys())
      reads.add(ref);
  };
  for (const seg of Object.values(artifacts.segments)) {
    // A segment's own partials are visible to its template/bg/fg/when (and to
    // each other) exactly as helpers are (candybar-templates-zh8b.53s) — a
    // read reachable only through one would otherwise never synthesize.
    const segScope =
      seg.partials === undefined ? helpers : { ...helpers, ...seg.partials };
    add(seg.template, segScope);
    add(seg.bg, segScope);
    add(seg.fg, segScope);
    add(seg.when, segScope);
    for (const body of Object.values(seg.partials ?? {})) add(body, segScope);
  }
  for (const tree of trees) {
    for (const node of walkNodes(tree)) {
      add(node.when);
      if (node.kind === "segment") {
        add(node.lead);
        add(node.trail);
      }
    }
  }
  for (const v of Object.values(artifacts.variables)) {
    if (v.kind === "template") add(v.template);
  }
  for (const a of Object.values(artifacts.actions)) {
    // [LAW:one-source-of-truth] Every arm's text, as the one walker lists it.
    for (const [, source] of actionTemplates(a)) add(source);
    const setBack =
      "set" in a ? SESSION_KEY_TO_EFFECTIVE_VAR.get(a.set) : undefined;
    const persistBack =
      "persist" in a ? CONFIG_KEY_TO_EFFECTIVE_VAR.get(a.persist) : undefined;
    if (setBack !== undefined) reads.add(setBack);
    if (persistBack !== undefined) reads.add(persistBack);
  }
  return reads;
}

// [LAW:no-silent-failure] A read that neither the artifacts nor `config`
// resolve (the scope cross-ref resolves against) is a defect in the synthesis
// — its chrome would render a ⚠ in every config — so it throws at load, naming
// the ref.
export function checkSynthesisReads(
  artifacts: SynthesisArtifacts,
  trees: readonly LayoutNode[],
  config: DslConfig,
): void {
  const own = templateScopeOf({
    ...config,
    variables: { ...config.variables, ...artifacts.variables },
    segments: { ...config.segments, ...artifacts.segments },
  });
  for (const ref of synthesisReads(artifacts, trees, config.helpers)) {
    if (refResolves(ref, own)) continue;
    throw new Error(
      `synthesized chrome reads ".${ref}", which neither it nor the config declares`,
    );
  }
}
