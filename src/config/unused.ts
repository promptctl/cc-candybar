// What a config FILE declares that nothing uses: a variable nothing reads, an
// action nothing clicks, a helper nothing calls, a segment no preset places
// (brandon-doctor-v62x.e91). The loader refuses a reference to a name that
// does not exist; this is the opposite question, and it is advisory — a
// declaration nothing uses still loads and renders.
//
// [LAW:effects-at-boundaries] Pure over the two shapes one load produces: the
// raw file (the names the author declared) and the merged config (everything
// that could use them, the bundled default's own templates included — a file's
// override of a bundled variable is used by the bundled segment that reads it).
//
// [LAW:single-enforcer] Every reference is found by the folds the loader's own
// cross-reference check runs (src/config/loader/refs.ts), so "is it used" and
// "does it resolve" read a template the same way, helpers included.

import {
  hasCacheField,
  walkNodes,
  type DslConfig,
  type RawDslConfig,
  type VariableDecl,
} from "./dsl-types.js";
import { isReservedName } from "./loader/reserved-namespace.js";
import {
  templateActionRefs,
  templateHelperRefs,
  templateReads,
} from "./loader/refs.js";
import { presetGlobals, presetNames, presetRoot } from "./presets.js";
import { EXPRESSION_SLOTS, isExpression } from "../themes/policy.js";

export type DeclKind = "variable" | "action" | "helper" | "segment";

export interface UnusedDecl {
  readonly kind: DeclKind;
  readonly name: string;
}

// Every variable of a section set under the name the store holds it by:
// globals bare, a segment's locals as `segName.varName`.
function* variablesOf(cfg: {
  readonly variables?: Readonly<Record<string, VariableDecl>>;
  readonly segments?: Readonly<
    Record<string, { readonly vars?: Readonly<Record<string, VariableDecl>> }>
  >;
}): IterableIterator<readonly [string, VariableDecl]> {
  yield* Object.entries(cfg.variables ?? {});
  for (const [segName, seg] of Object.entries(cfg.segments ?? {})) {
    for (const [name, v] of Object.entries(seg.vars ?? {})) {
      yield [`${segName}.${name}`, v];
    }
  }
}

// Every string of the merged config the engine evaluates as a template.
function* templatesOf(config: DslConfig): IterableIterator<string> {
  for (const seg of Object.values(config.segments)) {
    for (const t of [seg.template, seg.bg, seg.fg, seg.when]) {
      if (t !== undefined) yield t;
    }
  }
  for (const preset of presetNames(config.presets)) {
    for (const node of walkNodes(presetRoot(config, preset).node)) {
      if (node.when !== undefined) yield node.when;
    }
    const globals = presetGlobals(config, preset);
    for (const slot of EXPRESSION_SLOTS) {
      const rule = globals[slot];
      if (isExpression(rule)) yield rule;
    }
  }
  for (const [, v] of variablesOf(config)) {
    if (v.kind === "template") yield v.template;
    if (hasCacheField(v) && v.cache && "key" in v.cache) yield v.cache.key;
  }
  for (const a of Object.values(config.actions)) {
    if ("copy" in a) yield a.copy;
    if ("open" in a) yield a.open;
    if ("preset" in a && a.preset === "delete") yield a.name;
  }
}

// A read uses a variable when one names the other's dotted prefix: `.git`
// reads every `git.*`, and `.budget.spent` reads the document `budget`.
function readsVariable(read: string, name: string): boolean {
  return (
    read === name || name.startsWith(`${read}.`) || read.startsWith(`${name}.`)
  );
}

export function unusedDeclarations(
  raw: RawDslConfig,
  config: DslConfig,
): readonly UnusedDecl[] {
  const reads = new Set<string>();
  const bound = new Set<string>();
  const calledHelpers = new Set<string>();
  for (const template of templatesOf(config)) {
    for (const ref of templateReads(template, config.helpers).keys())
      reads.add(ref);
    for (const { name } of templateActionRefs(template, config.helpers))
      bound.add(name);
    for (const name of templateHelperRefs(template, config.helpers))
      calledHelpers.add(name);
  }
  for (const [, v] of variablesOf(config)) {
    if (hasCacheField(v) && v.cache && "depends_on" in v.cache) {
      for (const dep of v.cache.depends_on) reads.add(dep);
    }
  }

  // A `do` fires its members, so binding it clicks each of them.
  const clicked = new Set(bound);
  for (const name of bound) {
    const action = config.actions[name];
    if (action !== undefined && "do" in action) {
      for (const member of action.do) clicked.add(member);
    }
  }

  // A clicked `set` reads its key's current value back through the `state`
  // variable on that key (a cycle's successor, a picker's current mark).
  const writtenKeys = new Set<string>();
  const placed = new Set<string>();
  for (const name of clicked) {
    const action = config.actions[name];
    if (action === undefined) continue;
    if ("set" in action) writtenKeys.add(action.set);
    // A clicked insertion places its segment.
    if ("insertSegment" in action) placed.add(action.insertSegment);
    if (
      "insertSegmentFrom" in action &&
      Array.isArray(action.insertSegmentFrom)
    )
      for (const seg of action.insertSegmentFrom) placed.add(seg);
  }
  for (const preset of presetNames(config.presets)) {
    for (const node of walkNodes(presetRoot(config, preset).node)) {
      if (node.kind === "segment") placed.add(node.name);
    }
  }

  const variableUsed = (name: string, v: VariableDecl): boolean =>
    [...reads].some((read) => readsVariable(read, name)) ||
    (v.kind === "state" && writtenKeys.has(v.key));

  // [LAW:one-source-of-truth] A name under a reserved namespace was minted by
  // a synthesis pass into the raw sections (group sugar, edit mode), never
  // written by the author, so it is not theirs to remove.
  const authored = (names: Iterable<string>): string[] =>
    [...names].filter((name) => !isReservedName(name));
  const unusedOf = (
    kind: DeclKind,
    names: Iterable<string>,
    used: (name: string) => boolean,
  ): UnusedDecl[] =>
    authored(names)
      .filter((name) => !used(name))
      .map((name) => ({ kind, name }));

  const variables = new Map(variablesOf(raw));
  return [
    ...unusedOf("variable", variables.keys(), (name) =>
      variableUsed(name, variables.get(name)!),
    ),
    ...unusedOf("action", Object.keys(raw.actions ?? {}), (name) =>
      clicked.has(name),
    ),
    ...unusedOf("helper", Object.keys(raw.helpers ?? {}), (name) =>
      calledHelpers.has(name),
    ),
    ...unusedOf("segment", Object.keys(raw.segments ?? {}), (name) =>
      placed.has(name),
    ),
  ];
}
