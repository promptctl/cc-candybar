// [LAW:single-enforcer] The SessionState instance of the shared keyed-validator registry:
// the registered keys ARE the schema. [LAW:one-type-per-behavior] The spec algebra is shared with config-validators.ts.

import { listResolvablePaletteNames, STRIP_STYLES } from "../../themes/policy";
import { actionDestinations, type ActionDecl } from "../../config/action";
import {
  perConfigDomainsFor,
  resolveOptionDomain,
} from "../../config/option-domain";
import type { DslConfig } from "../../config/dsl-types";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import {
  clampSeed,
  createValidatorRegistry,
  mergeContributions,
  type DerivedValidatorSpec,
  type KeySpecContribution,
  type KeyValidator,
  type RangeParams,
  type ValidateResult,
} from "./validator-registry";

export type {
  DerivedValidatorSpec,
  KeySpecContribution,
  KeyValidator,
  RangeParams,
  ValidateResult,
} from "./validator-registry";
// [LAW:locality-or-seam] A stable barrel, so no consumer needs to know where the builders live.
export {
  makeAllowListValidator,
  makeIntValidator,
  makeRangeValidator,
} from "./validator-registry";

// [LAW:one-source-of-truth] Excludes the "custom" sentinel — it needs inline colors, so persisting it would break the next render.
const RESOLVABLE_THEMES_LIST: readonly string[] = listResolvablePaletteNames();
const RESOLVABLE_THEMES: ReadonlySet<string> = new Set(RESOLVABLE_THEMES_LIST);
const RESOLVABLE_STYLES: ReadonlySet<string> = new Set(STRIP_STYLES);

const validateTheme: KeyValidator = (raw) => {
  if (!raw) return { ok: false, reason: "theme name is required" };
  if (!RESOLVABLE_THEMES.has(raw)) {
    return {
      ok: false,
      reason: `unknown theme "${raw}" (have: ${RESOLVABLE_THEMES_LIST.join(", ")})`,
    };
  }
  return { ok: true, value: raw };
};

const validateStyle: KeyValidator = (raw) => {
  if (!raw) return { ok: false, reason: "style name is required" };
  if (!RESOLVABLE_STYLES.has(raw)) {
    return {
      ok: false,
      reason: `unknown style "${raw}" (have: ${STRIP_STYLES.join(", ")})`,
    };
  }
  return { ok: true, value: raw };
};

// [LAW:dataflow-not-control-flow] Four canonical inputs normalize to two outputs; the falsy sentinel is "", what `clear()` leaves.
const BOOLEAN_TRUTHY = new Set(["1", "true"]);
const BOOLEAN_FALSY = new Set(["0", "false"]);
const validateBoolean: KeyValidator = (raw) => {
  if (BOOLEAN_TRUTHY.has(raw)) return { ok: true, value: "1" };
  if (BOOLEAN_FALSY.has(raw)) return { ok: true, value: "" };
  return {
    ok: false,
    reason: `expected boolean-ish (1, 0, true, false), got "${raw}"`,
  };
};

// [LAW:one-source-of-truth] Baseline keys are permanent; every other key is derived from a config's action table.
const registry = createValidatorRegistry({
  style: validateStyle,
  theme: validateTheme,
  "toolbar-expanded": validateBoolean,
});

export function listStateKeys(): readonly string[] {
  return registry.listKeys();
}

export function registerStateValidator(
  key: string,
  spec: DerivedValidatorSpec,
): () => void {
  return registry.register(key, spec);
}

export function validateStateWrite(
  key: string,
  rawValue: string,
): ValidateResult {
  return registry.validate(key, rawValue);
}

export function rangeParamsFor(key: string): RangeParams | null {
  return registry.rangeParamsFor(key);
}

// [LAW:one-source-of-truth] The ONE map from a `set` ACTION to the key SPEC it declares; config-validators.ts holds the `persist` twin.
function actionKeySpecs(
  a: ActionDecl,
  seeds: ReadonlyMap<string, number>,
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): KeySpecContribution[] {
  if (!("set" in a)) return [];
  if ("to" in a) {
    return [{ key: a.set, spec: { kind: "allow-list", allowed: [a.to] } }];
  }
  if ("from" in a) {
    return [
      {
        key: a.set,
        spec: {
          kind: "allow-list",
          allowed: resolveOptionDomain(a.from, perConfigDomains),
        },
      },
    ];
  }
  if ("int" in a) {
    return [{ key: a.set, spec: { kind: "int" } }];
  }
  if ("cycle" in a) {
    return [{ key: a.set, spec: { kind: "allow-list", allowed: a.cycle } }];
  }
  return [
    {
      key: a.set,
      spec: {
        kind: "range",
        min: a.min,
        max: a.max,
        seed: clampSeed(seeds.get(a.set), a.min, a.max),
      },
    },
  ];
}

// [LAW:single-enforcer] A STRUCTURAL spec is kept even on a baseline key so a collision throws loudly; only an allow-list one is dropped.
function dropBaselineAllowLists(
  contributions: readonly KeySpecContribution[],
): KeySpecContribution[] {
  const baseline = new Set(registry.listBaselineKeys());
  return contributions.filter(
    (c) => c.spec.kind !== "allow-list" || !baseline.has(c.key),
  );
}

// [LAW:one-source-of-truth] The value a bounded key renders with before any click: a
// `state` var's integer `default`, else the GLOBALS field the config-file gate also seeds from.
function stateKeySeeds(config: DslConfig): ReadonlyMap<string, number> {
  const seeds = new Map<string, number>();
  const INT_RE = /^-?\d+$/;
  for (const decl of Object.values(config.variables)) {
    if (decl.kind !== "state") continue;
    const raw = decl.default;
    if (raw !== undefined && INT_RE.test(raw)) {
      seeds.set(decl.key, parseInt(raw, 10));
    }
  }
  for (const [key, seed] of numericGlobalsSeeds(config.globals)) {
    seeds.set(key, seed);
  }
  return seeds;
}

// [LAW:one-source-of-truth] The declarations `{{ action }}` realizes a click from ARE the gate the wire enforces.
function actionContributions(config: DslConfig): KeySpecContribution[] {
  const seeds = stateKeySeeds(config);
  const perConfigDomains = perConfigDomainsFor(config);
  // [LAW:single-enforcer] Actions explode into single-destination declarations before the fold, so a dual can widen nothing.
  return dropBaselineAllowLists(
    Object.values(config.actions)
      .flatMap(actionDestinations)
      .flatMap((a) => actionKeySpecs(a, seeds, perConfigDomains)),
  );
}

// [LAW:single-enforcer] The SOLE install-site derivation, through ONE coherence pass.
export function deriveActionValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions(actionContributions(config));
}
