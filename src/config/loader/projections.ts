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
// The declared names ride beside the answer: a cache key is read against the
// same names the fold read [LAW:one-source-of-truth].
interface Fold {
  readonly names: ReadonlySet<string>;
  readonly projections: Projections;
}

const FOLDS = new WeakMap<ProjectionConfig, Fold>();

function foldOf(config: ProjectionConfig): Fold {
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

// The declared variable names the fold read the config's templates against.
export function variableNamesOf(config: ProjectionConfig): ReadonlySet<string> {
  return foldOf(config).names;
}

function foldProjections(config: ProjectionConfig): Fold {
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
  return { names, projections };
}

// Why a template reads the instant, through the config's projections; null
// when it reads none. What a cache key is refused for.
export function instantReadOf(
  template: string,
  config: ProjectionConfig,
): string | null {
  const { names, projections } = foldOf(config);
  return instantRead(template, {
    helpers: config.helpers,
    names,
    projections,
    clock: CLOCK_FUNCTIONS,
  });
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
    // [LAW:no-defensive-null-guards] cross-ref proved every bound action is
    // declared.
    const decl = actions[name]!;
    const reads =
      [...actionTemplates(decl)].some(
        ([, source]) => instantRead(source, basis) !== null,
      ) ||
      ("do" in decl && decl.do.some(actionReadsInstant));
    actionReads.set(name, reads);
    return reads;
  };
  return (template) =>
    instantRead(template, basis) !== null ||
    templateActionRefs(template, basis.helpers).some((ref) =>
      actionReadsInstant(ref.name),
    );
}
