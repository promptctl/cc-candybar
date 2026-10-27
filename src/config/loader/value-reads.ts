// [LAW:single-enforcer] What a value reads, folded once. A draw follows every
// edge here: a variable's template, the key its cache re-runs on and the names
// it depends on, and in a template every action it binds, whose own text
// `realize` evaluates inside that template. Every walk that asks what a value
// reads — the input closure, the projection fold, the cycle graph, the
// variable-scope fold, the rule-slot check and the unused check — asks this,
// so an edge kind is added here once and none of them can miss it.
//
// [LAW:one-source-of-truth] A read is told against the declared names through
// the one resolver (`variableRead`), so every walk lands it on the same
// declarations the draw does.

import { actionTemplates, type ActionDecl } from "../action.js";
import {
  hasCacheField,
  variableTemplates,
  type DslConfig,
  type VariableDecl,
} from "../dsl-types.js";
import {
  bindsComputedAction,
  declaredVariables,
  templateActionRefs,
  templateFunctions,
  templateReads,
  variableRead,
} from "./refs.js";

// What reads are told against: the declared names, the helpers a template's
// text calls, and the actions it binds.
export interface ReadBasis {
  readonly names: ReadonlySet<string>;
  readonly helpers: Readonly<Record<string, string>>;
  readonly actions: Readonly<Record<string, ActionDecl>>;
}

// One read: the path as spelled, and the declarations it reaches — none for a
// read of nothing declared (a payload field only a view answers, or a name
// cross-ref refuses).
export interface ValueRead {
  readonly path: string;
  readonly reaches: readonly string[];
}

// Which part of a variable makes a read: its template, the key its cache
// re-runs on, or a name its cache depends on.
export interface VariableRead extends ValueRead {
  readonly field: "template" | "cache.key" | "cache.depends_on";
}

export interface ValueReads {
  // Every read a template's draw makes: its own text's, and the text of each
  // action it binds — spelled, a `do`'s members, or, for a name it computes,
  // every declared action.
  ofTemplate(template: string): readonly ValueRead[];
  // Every function that draw calls, by name, over the same texts.
  calls(template: string): ReadonlySet<string>;
  // Every read a variable makes.
  ofVariable(decl: VariableDecl): readonly VariableRead[];
}

export function valueReads({ names, helpers, actions }: ReadBasis): ValueReads {
  // The texts one bound action realizes: its own, and its members'. An action
  // no declaration names realizes nothing: cross-ref refuses it where it is
  // bound [LAW:no-silent-failure].
  const actionTexts = (name: string, seen: Set<string>): string[] => {
    const decl = Object.hasOwn(actions, name) ? actions[name] : undefined;
    if (decl === undefined || seen.has(name)) return [];
    seen.add(name);
    return [
      ...[...actionTemplates(decl)].map(([, source]) => source),
      ...("do" in decl ? decl.do.flatMap((m) => actionTexts(m, seen)) : []),
    ];
  };
  // Every text a template's draw evaluates: itself, then its bound actions'.
  // Answered once per template: the reads and the calls both ask, and the
  // bound actions are two walks of the template's call graph.
  const texts = perTemplate((template): readonly string[] => {
    const bound = bindsComputedAction(template, helpers)
      ? Object.keys(actions)
      : templateActionRefs(template, helpers).map((ref) => ref.name);
    const seen = new Set<string>();
    return [template, ...bound.flatMap((name) => actionTexts(name, seen))];
  });
  const ofTemplate = perTemplate((template) =>
    texts(template).flatMap((text) =>
      [...templateReads(text, helpers).keys()].map((path) => ({
        path,
        reaches: variableRead(path, names),
      })),
    ),
  );
  const calls = perTemplate(
    (template): ReadonlySet<string> =>
      new Set(
        texts(template).flatMap((text) => [
          ...templateFunctions(text, helpers),
        ]),
      ),
  );
  // [LAW:one-source-of-truth] A variable's edges, by kind: the one place a
  // kind's reads are spelled. `depends_on` names a store key exactly (the
  // reaction reads the store by it), so it reaches that name or nothing.
  const ofVariable = (decl: VariableDecl): readonly VariableRead[] => [
    ...variableTemplates(decl).flatMap(([field, template]) =>
      ofTemplate(template).map((read) => ({ ...read, field })),
    ),
    ...(hasCacheField(decl) && "depends_on" in decl.cache
      ? decl.cache.depends_on.map((name) => ({
          path: name,
          reaches: names.has(name) ? [name] : [],
          field: "cache.depends_on" as const,
        }))
      : []),
  ];
  return { ofTemplate, calls, ofVariable };
}

// [LAW:one-source-of-truth] The payload path a declaration reads: an input's
// `path`, and a plugin source's own name, since its reading travels in the
// payload at the name it is declared under. Every other kind reads the payload
// only through the declarations it reads (`ofVariable`). A walk that follows
// what a value reads down to the payload — the input closure, the rule-slot
// check, the projection fold — asks this, so a kind that reads the payload is
// spelled here once.
export function payloadPathOf(
  name: string,
  decl: VariableDecl,
): string | undefined {
  switch (decl.kind) {
    case "input":
      return decl.path;
    case "source":
      return name;
    default:
      return undefined;
  }
}

// One answer per template text: a gate's text recurs at every node of every
// preset that edit chrome wraps alike.
function perTemplate<T>(answer: (template: string) => T): (t: string) => T {
  const answers = new Map<string, T>();
  return (template) => {
    if (!answers.has(template)) answers.set(template, answer(template));
    return answers.get(template)!;
  };
}

// A config's fold, built once per config object: every walk over one config
// reads the same answers.
const FOLDS = new WeakMap<object, ValueReads>();

export function valueReadsOf(
  config: Pick<DslConfig, "variables" | "segments" | "helpers" | "actions">,
): ValueReads {
  let fold = FOLDS.get(config);
  if (fold === undefined) {
    fold = valueReads({
      names: new Set([...declaredVariables(config)].map(([name]) => name)),
      helpers: config.helpers,
      actions: config.actions,
    });
    FOLDS.set(config, fold);
  }
  return fold;
}
