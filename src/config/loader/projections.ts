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
import { CLOCK_FUNCTIONS } from "../../template-engine/engine.js";
import {
  declaredVariables,
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
type Projections = ReadonlyMap<string, string>;

// Why a template reads the instant, against the projections known so far:
// the first clock function it calls, else the first projection it reads.
// Null for a template that reads no instant.
function instantRead(
  template: string,
  config: ProjectionConfig,
  names: ReadonlySet<string>,
  projections: Projections,
): string | null {
  for (const name of templateFunctions(template, config.helpers)) {
    if (CLOCK_FUNCTIONS.has(name)) return `calls "${name}"`;
  }
  for (const path of templateReads(template, config.helpers).keys()) {
    const read = variableRead(path, names);
    const why = read === null ? undefined : projections.get(read);
    if (why !== undefined) return `reads "${read}", which ${why}`;
  }
  return null;
}

// [LAW:dataflow-not-control-flow] One fold to a fixpoint: a `time` variable
// starts as a projection, and a template variable joins once its template
// reads the instant through anything already in. Computed once per config
// object: the loader's check and every declaration read the same answer.
const PROJECTIONS = new WeakMap<ProjectionConfig, Projections>();

export function projectionsOf(config: ProjectionConfig): Projections {
  let projections = PROJECTIONS.get(config);
  if (projections === undefined) {
    projections = foldProjections(config);
    PROJECTIONS.set(config, projections);
  }
  return projections;
}

function foldProjections(config: ProjectionConfig): Projections {
  const declared = new Map(declaredVariables(config));
  const names = new Set(declared.keys());
  const projections = new Map<string, string>();
  for (const [name, decl] of declared) {
    if (decl.kind === "time") projections.set(name, "is a time variable");
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, decl] of declared) {
      if (decl.kind !== "template" || projections.has(name)) continue;
      const why = instantRead(decl.template, config, names, projections);
      if (why !== null) {
        projections.set(name, why);
        grew = true;
      }
    }
  }
  return projections;
}

// Why a template reads the instant, through the config's projections; null
// when it reads none. What a cache key is refused for.
export function instantReadOf(
  template: string,
  config: ProjectionConfig,
): string | null {
  const names = new Set([...declaredVariables(config)].map(([name]) => name));
  return instantRead(template, config, names, projectionsOf(config));
}
