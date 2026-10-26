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
// engine's clock factories return), an input at a field the draw's instant
// answers (DRAW_PROJECTIONS), an input at a selection slot's `.effective` whose
// rule reads the instant — or reads a projection. The set is closed upward:
// whatever reads a projection is one.

import type { DslConfig } from "../dsl-types.js";
import { EXPRESSION_SLOTS, isExpression } from "../../themes/policy.js";
import type { ExpressionSlot } from "../../themes/policy.js";
import {
  DRAW_PROJECTIONS,
  drawProjectionAt,
  slotAt,
} from "../payload-inputs.js";
import { CLOCK_FUNCTIONS } from "../../template-engine/engine.js";
import { declaredVariables } from "./refs.js";
import { payloadPathOf, valueReadsOf, type ValueReads } from "./value-reads.js";

export type ProjectionConfig = Pick<
  DslConfig,
  "variables" | "segments" | "helpers" | "actions" | "globals" | "presets"
>;

// Each projection, with why it reads the instant, as a load error says it:
// `is a time variable`, `calls "now"`, `reads "clock", which calls "now"`.
export type Projections = ReadonlyMap<string, string>;

// [LAW:one-source-of-truth] What a template's instant reads are told against,
// beside its text: the one fold of what it reads and calls (value-reads.ts),
// the projections among the names it reads, and the clock functions of the
// engine that evaluates it.
export interface InstantBasis {
  readonly reads: ValueReads;
  readonly projections: Projections;
  readonly clock: ReadonlySet<string>;
}

// Why a template reads the instant, against the projections known so far:
// the first clock function its draw calls, else the first projection it
// reads — the actions it binds included, since an `{{ action }}` realizes its
// `copy`/`open` text inside the template that binds it. Null for a template
// that reads no instant.
function instantRead(template: string, basis: InstantBasis): string | null {
  for (const name of basis.reads.calls(template)) {
    if (basis.clock.has(name)) return `calls "${name}"`;
  }
  for (const { reaches } of basis.reads.ofTemplate(template)) {
    for (const name of reaches) {
      const why = basis.projections.get(name);
      if (why !== undefined) return `reads "${name}", which ${why}`;
    }
  }
  return null;
}

// [LAW:dataflow-not-control-flow] One fold to a fixpoint: a `time` variable
// starts as a projection, and a template variable joins once its template
// reads the instant through anything already in. Computed once per config
// object: the loader's check and every declaration read the same answer.
// The answer is the basis it was told against, its reads included: a cache
// key is read against the same basis the fold read
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
  const projections = new Map<string, string>();
  const basis: InstantBasis = {
    reads: valueReadsOf(config),
    projections,
    clock: CLOCK_FUNCTIONS,
  };
  for (const [name, decl] of declared) {
    if (decl.kind === "time") projections.set(name, "is a time variable");
    const at = payloadPathOf(name, decl);
    const drawn = at === undefined ? null : drawProjectionAt(at);
    if (drawn)
      projections.set(
        name,
        `reads the draw's "${drawn}" (${DRAW_PROJECTIONS[drawn]})`,
      );
  }
  // [LAW:one-source-of-truth] A slot's rule decides the name its `.effective`
  // reads, so a rule reading the instant makes every input at that path one.
  const rules = rulesOf(config);
  const slotReads = new Map<ExpressionSlot, string>();
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
    for (const slot of EXPRESSION_SLOTS) {
      if (slotReads.has(slot)) continue;
      for (const rule of rules[slot]) {
        const why = instantRead(rule, basis);
        if (why === null) continue;
        slotReads.set(slot, why);
        grew = true;
        break;
      }
    }
    for (const [name, decl] of declared) {
      const at = payloadPathOf(name, decl);
      if (at === undefined || projections.has(name)) continue;
      const slot = slotAt(at);
      const why = slot === undefined ? undefined : slotReads.get(slot);
      if (why === undefined) continue;
      projections.set(name, `reads the ${slot} rule, which ${why}`);
      grew = true;
    }
  }
  return basis;
}

// A globals rule as authored: the slot it decides, its text, and the config
// path it was written at.
export interface AuthoredRule {
  readonly at: readonly string[];
  readonly slot: ExpressionSlot;
  readonly rule: string;
}

// [LAW:one-source-of-truth] Every rule a selection slot may hold: the
// config's globals and each preset's, as the config-default rung reads them.
// The load checks, the projection fold and the compile all read this one
// enumeration, so a new place to author a rule is one edit here.
export function authoredRules(
  config: Pick<DslConfig, "globals" | "presets">,
): readonly AuthoredRule[] {
  const fragments: ReadonlyArray<
    readonly [readonly string[], DslConfig["globals"]]
  > = [
    [["globals"], config.globals],
    ...Object.entries(config.presets ?? {}).map(
      ([name, preset]) =>
        [["presets", name, "globals"], preset.globals ?? {}] as const,
    ),
  ];
  return fragments.flatMap(([at, globals]) =>
    EXPRESSION_SLOTS.flatMap((slot) => {
      const rule = globals[slot];
      return isExpression(rule) ? [{ at: [...at, slot], slot, rule }] : [];
    }),
  );
}

function rulesOf(
  config: ProjectionConfig,
): Readonly<Record<ExpressionSlot, readonly string[]>> {
  const rules = authoredRules(config);
  const rulesIn = (slot: ExpressionSlot): readonly string[] =>
    rules.flatMap((r) => (r.slot === slot ? [r.rule] : []));
  return {
    style: rulesIn("style"),
    palette: rulesIn("palette"),
    effect: rulesIn("effect"),
  };
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
// segment's parts, a layout node's `when`, a globals rule, an action's text.
// `clock` is the clock functions of the compile's engine, which may add its
// own to the engine's. A template this answers false for is kept as a derived
// value of the view it is drawn in (src/dsl/parts.ts), so the answer must
// cover every way a template reaches the clock: one it misses throws at its
// first draw (template-engine/engine.ts, drawInProgress). The fold's edges are
// the draw's, so it does.
export function templateInstants(
  basis: InstantBasis,
): (template: string) => boolean {
  return (template) => instantRead(template, basis) !== null;
}
