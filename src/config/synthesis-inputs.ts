// [LAW:one-source-of-truth] What a synthesis pass depends on rather than owns.
// The settings menu and edit chrome mint segments, actions and variables into
// every config (brandon-settings-menu-d6f), and their output does not re-enter
// cross-ref, so a read they mint that nothing declares would render a ⚠ in
// every bar. What they read is payload inputs, which every merged config
// carries by construction, and their own names, so whether they resolve does
// not depend on the config: the proof is a test over loaded configs, and a
// load pays nothing for it. The reads are derived from the config, never a
// hand-kept list, so a read a later control adds is checked with no second
// place to update.

import { actionTemplates } from "./action.js";
import { walkNodes, type DslConfig } from "./dsl-types.js";
import { presetNames, presetRoot } from "./presets.js";
import { templateReads, refResolves, templateScopeOf } from "./loader/refs.js";
import {
  CONFIG_KEY_TO_EFFECTIVE_VAR,
  SESSION_KEY_TO_EFFECTIVE_VAR,
} from "./setting-projections.js";

// Every variable the synthesis minted into `config` READS. Three kinds of read: the dotted refs of
// every template (segment fields, node `when`s and the lead/trail drawn in a
// segment node's cell, template variables, copy/open actions); and the
// `.effective` projection a
// `set` or `persist` on a setting reads its current value back through
// (registerDslConfig's stateKeyToVar, CONFIG_KEY_TO_EFFECTIVE_VAR).
function mintedReads(config: DslConfig, before: DslConfig): Set<string> {
  const helpers = config.helpers;
  const minted = <T>(
    all: Readonly<Record<string, T>>,
    had: Readonly<Record<string, T>>,
  ): T[] =>
    Object.entries(all)
      .filter(([name]) => !(name in had))
      .map(([, decl]) => decl);
  const reads = new Set<string>();
  const add = (
    template: string | undefined,
    scope: Readonly<Record<string, string>> = helpers,
  ): void => {
    for (const ref of templateReads(template ?? "", scope).keys())
      reads.add(ref);
  };
  for (const seg of minted(config.segments, before.segments)) {
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
  for (const name of presetNames(config.presets)) {
    const tree = presetRoot(config, name).node;
    for (const node of walkNodes(tree)) {
      add(node.when);
      if (node.kind === "segment") {
        add(node.lead);
        add(node.trail);
      }
    }
  }
  for (const v of minted(config.variables, before.variables)) {
    if (v.kind === "template") add(v.template);
  }
  for (const a of minted(config.actions, before.actions)) {
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

// Every read the synthesis minted into `config`, over `before` (the merged,
// cross-referenced config it was synthesized from), that `config` does not
// resolve. The trees are walked whole: the author's nodes in them were
// resolved by cross-ref against the same scope, so they cost nothing to read.
export function unresolvedReads(
  config: DslConfig,
  before: DslConfig,
): string[] {
  const scope = templateScopeOf(config);
  return [...mintedReads(config, before)].filter(
    (ref) => !refResolves(ref, scope),
  );
}
