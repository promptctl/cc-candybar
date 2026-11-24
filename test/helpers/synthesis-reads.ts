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
import {
  walkNodes,
  type DslConfig,
  type SegmentDecl,
} from "../../src/config/dsl-types.js";
import { SEGMENT_TEMPLATE_FIELDS } from "../../src/config/loader/plugins.js";
import { ownValue } from "../../src/utils/plain.js";
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

// Every read the synthesis minted or broke over `before`, and every node of
// the preset trees, author nodes included. Two kinds of read:
// the dotted refs of every template (segment fields, node `when`s and the
// lead/trail drawn in a segment node's cell, template variables, copy/open
// actions); and the `.effective` projection a `set` or `persist` on a setting
// reads its current value back through (CONFIG_KEY_TO_EFFECTIVE_VAR).
export function synthesisReads(
  config: DslConfig,
  before: DslConfig,
): Set<string> {
  return changedReads(config, before).reads;
}

function changedReads(config: DslConfig, before: DslConfig) {
  const helpers = config.helpers;
  const priorScope = templateScopeOf(before);
  const scope = templateScopeOf(config);
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
  const add = (template: string | undefined): void => {
    for (const ref of templateReads(template ?? "", helpers).keys())
      reads.add(ref);
  };
  // [LAW:behavior-not-structure] Synthesis can add a read or break an
  // existing binding without changing the template. Leave inherited
  // segment-only reads (such as .settings) to their authored cross-check.
  for (const [name, segment] of Object.entries(config.segments)) {
    const prior = ownValue(before.segments, name);
    const current = segmentReads(segment, helpers);
    const previous =
      prior === segment && before.helpers === helpers
        ? current
        : prior && segmentReads(prior, before.helpers);
    for (const ref of current) {
      if (
        !previous?.has(ref) ||
        (refResolves(ref, priorScope) && !refResolves(ref, scope))
      ) {
        reads.add(ref);
      }
    }
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
  return { reads, scope };
}

// Read bodies in the scope their segment declared so a reference reached
// through a partial counts just like one used directly by a template.
function segmentReads(
  segment: SegmentDecl,
  helpers: DslConfig["helpers"],
): Set<string> {
  const scope =
    segment.partials === undefined
      ? helpers
      : { ...helpers, ...segment.partials };
  const templates = [
    ...SEGMENT_TEMPLATE_FIELDS.map((field) => segment[field]),
    ...Object.values(segment.partials ?? {}),
  ];
  const reads = new Set<string>();
  for (const template of templates) {
    if (template === undefined) continue;
    for (const ref of templateReads(template, scope).keys()) reads.add(ref);
  }
  return reads;
}

// Every newly unresolved read after synthesis, relative to the merged,
// cross-referenced config it was synthesized from.
export function unresolvedReads(
  config: DslConfig,
  before: DslConfig,
): string[] {
  const { reads, scope } = changedReads(config, before);
  return [...reads].filter((ref) => !refResolves(ref, scope));
}
