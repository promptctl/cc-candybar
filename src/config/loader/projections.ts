// [LAW:single-enforcer] Which of a config's values are PROJECTIONS: values of
// the instant a frame is drawn at (brandon-unfiled-3248.8ro6, step 6). A
// projection is evaluated by each draw at that instant, and a store cannot
// hold one, because it would change every frame. One fold decides it, and two
// things read it: the declaration, which keeps no answer for a projection
// (VariableStore's `Derivation`), and the load, which refuses a cache policy
// that reads one (cross-ref.ts) — a policy re-runs its source when a stored
// value changes, and the instant is no stored value.
//
// A value is a projection when it reads the instant itself — a `time`
// variable, a template calling a clock function (CLOCK_FUNCTIONS: the names the
// engine's clock factories return) — or reads a projection. The set is closed
// upward: whatever reads a projection is one.

import type { DslConfig } from "../dsl-types.js";
import { actionTemplates, type ActionDecl } from "../action.js";
import { CLOCK_FUNCTIONS } from "../../template-engine/engine.js";
import {
  bindsComputedAction,
  declaredVariables,
  templateActionRefs,
  templateFunctions,
  templateReads,
  variableRead,
} from "./refs.js";

export type ProjectionConfig = Pick<
  DslConfig,
  "variables" | "segments" | "helpers"
>;

// Each projection, with why it reads the instant, as a load error says it:
// `is a time variable`, `calls "now"`, `reads "clock", which calls "now"`.
export type Projections = ReadonlyMap<string, string>;

// [LAW:one-source-of-truth] What a template's instant reads are told against,
// beside its text: the helpers it may call, the declared variable names (a read
// lands on the longest it starts with), the projections among them, and the
// clock functions of the engine that evaluates it.
export interface InstantBasis {
  readonly helpers: Readonly<Record<string, string>>;
  readonly names: ReadonlySet<string>;
  readonly projections: Projections;
  readonly clock: ReadonlySet<string>;
}

// Why a template reads the instant, against the projections known so far:
// the first clock function it calls, else the first projection it reads.
// Null for a template that reads no instant.
function instantRead(template: string, basis: InstantBasis): string | null {
  for (const name of templateFunctions(template, basis.helpers)) {
    if (basis.clock.has(name)) return `calls "${name}"`;
  }
  for (const path of templateReads(template, basis.helpers).keys()) {
    const read = variableRead(path, basis.names);
    const why = read === null ? undefined : basis.projections.get(read);
    if (why !== undefined) return `reads "${read}", which ${why}`;
  }
  return null;
}

// [LAW:dataflow-not-control-flow] One fold to a fixpoint: a `time` variable
// starts as a projection, and a template variable joins once its template
// reads the instant through anything already in. Computed once per config
// object: the loader's check and every declaration read the same answer.
// The answer is the basis it was told against, declared names included: a
// cache key is read against the same basis the fold read
// [LAW:one-source-of-truth].
const FOLDS = new WeakMap<ProjectionConfig, InstantBasis>();

function foldOf(config: ProjectionConfig): InstantBasis {
  let fold = FOLDS.get(config);
  if (fold === undefined) {
    fold = foldProjections(config);
    FOLDS.set(config, fold);
  }
  return fold;
}

export function projectionsOf(config: ProjectionConfig): Projections {
  return foldOf(config).projections;
}

function foldProjections(config: ProjectionConfig): InstantBasis {
  const declared = new Map(declaredVariables(config));
  const names = new Set(declared.keys());
  const projections = new Map<string, string>();
  const basis: InstantBasis = {
    helpers: config.helpers,
    names,
    projections,
    clock: CLOCK_FUNCTIONS,
  };
  for (const [name, decl] of declared) {
    if (decl.kind === "time") projections.set(name, "is a time variable");
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, decl] of declared) {
      if (decl.kind !== "template" || projections.has(name)) continue;
      const why = instantRead(decl.template, basis);
      if (why !== null) {
        projections.set(name, why);
        grew = true;
      }
    }
  }
  return basis;
}

// Why a template reads the instant, through the config's projections; null
// when it reads none. What a cache key is refused for.
export function instantReadOf(
  template: string,
  config: ProjectionConfig,
): string | null {
  return instantRead(template, foldOf(config));
}

// [LAW:single-enforcer] Which of a compile's templates read the instant — a
// segment's parts, a layout node's `when`, a globals rule, an action's text:
// those that read it as a variable's template would, and those that bind an
// action whose own text reads it, since an `{{ action }}` realizes its
// `copy`/`open` text inside the template that binds it. `clock` is the clock
// functions of the compile's engine, which may add its own to the engine's.
// A template this answers false for is kept as a derived value of the view it
// is drawn in (src/dsl/parts.ts), so the answer must cover every way a
// template reaches the clock: one it misses throws at its first draw
// (template-engine/engine.ts, drawInProgress).
export function templateInstants(
  basis: InstantBasis,
  actions: Readonly<Record<string, ActionDecl>>,
): (template: string) => boolean {
  const actionReads = new Map<string, boolean>();
  const actionReadsInstant = (name: string): boolean => {
    const known = actionReads.get(name);
    if (known !== undefined) return known;
    // A `do` names its members, never itself or a nested `do` (cross-ref), so
    // the walk ends; the entry guards it while it runs.
    actionReads.set(name, false);
    // [LAW:no-silent-failure] An action no declaration names binds nothing,
    // so nothing of its reads the instant: the template that names it fails
    // where it binds it, as it would kept or projected. cross-ref refuses one
    // in a segment's or a layout node's templates; a globals rule, or an
    // action's own text, is checked only where it is evaluated.
    const decl = actions[name];
    if (decl === undefined) return false;
    const reads =
      [...actionTemplates(decl)].some(
        ([, source]) => instantRead(source, basis) !== null,
      ) ||
      ("do" in decl && decl.do.some(actionReadsInstant));
    actionReads.set(name, reads);
    return reads;
  };
  // A name the template computes may be any declared action's.
  let anyReads: boolean | undefined;
  const anyActionReadsInstant = (): boolean =>
    (anyReads ??= Object.keys(actions).some(actionReadsInstant));
  // One answer per source: a gate's text recurs at every node of every
  // preset that edit chrome wraps alike.
  const answers = new Map<string, boolean>();
  return (template) => {
    let reads = answers.get(template);
    if (reads === undefined) {
      reads =
        instantRead(template, basis) !== null ||
        templateActionRefs(template, basis.helpers).some((ref) =>
          actionReadsInstant(ref.name),
        ) ||
        (bindsComputedAction(template, basis.helpers) &&
          anyActionReadsInstant());
      answers.set(template, reads);
    }
    return reads;
  };
}

// [LAW:one-source-of-truth] The declared names that decide whether a read
// lands on a projection: each projection, and every name nested under one. A
// read lands on the longest declared name it starts with, so whatever lies
// outside these resolves a read no differently — a compile keyed on them alone
// is shared by configs that declare other variables differently.
export function projectionNamesOf(config: ProjectionConfig): string[] {
  const { names, projections } = foldOf(config);
  return [...names]
    .filter((name) =>
      [...projections.keys()].some(
        (projection) =>
          name === projection || name.startsWith(`${projection}.`),
      ),
    )
    .sort();
}
