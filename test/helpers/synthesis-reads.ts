// [LAW:no-silent-failure] exception: a load does not re-prove the reads the
// settings menu, edit chrome and placement menus mint, though their output
// does not re-enter cross-ref and an unresolved one renders a ⚠ in every bar.
// They read payload inputs, `.effective` projections and names the passes
// declare themselves; only which of those names exist follows the config
// (presets, placements, a segment's settings, `{{ menu }}` calls). So a test
// over authored configs names any unresolved read, and a load pays nothing.
// The reads are derived from the config, never a hand-kept list, so a read a
// later control adds is checked with no second place to update.

import { actionTemplates } from "../../src/config/action.js";
import { walkNodes, type DslConfig } from "../../src/config/dsl-types.js";
import { presetNames, presetRoot } from "../../src/config/presets.js";
import {
  templateReads,
  refResolves,
  templateScopeOf,
} from "../../src/config/loader/refs.js";
import {
  CONFIG_KEY_TO_EFFECTIVE_VAR,
  SESSION_KEY_TO_EFFECTIVE_VAR,
} from "../../src/config/setting-projections.js";

// Every variable `config` reads that the synthesis minted over `before`, and
// every node of the preset trees, author nodes included. Two kinds of read:
// the dotted refs of every template (segment fields, node `when`s and the
// lead/trail drawn in a segment node's cell, template variables, copy/open
// actions); and the `.effective` projection a `set` or `persist` on a setting
// reads its current value back through (CONFIG_KEY_TO_EFFECTIVE_VAR).
export function synthesisReads(
  config: DslConfig,
  before: DslConfig,
): Set<string> {
  const helpers = config.helpers;
  const minted = <T>(
    all: Readonly<Record<string, T>>,
    had: Readonly<Record<string, T>>,
  ): T[] =>
    Object.entries(all)
      // By identity, so a pass's declaration that replaces one of the same
      // name is checked too.
      .filter(([name, decl]) => had[name] !== decl)
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
// resolve. Author nodes in the trees resolved in cross-ref against the merged
// config, and the synthesized config's scope only adds to it, so they read
// clean here.
export function unresolvedReads(
  config: DslConfig,
  before: DslConfig,
): string[] {
  const scope = templateScopeOf(config);
  return [...synthesisReads(config, before)].filter(
    (ref) => !refResolves(ref, scope),
  );
}
