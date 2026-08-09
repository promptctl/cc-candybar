// [LAW:single-enforcer] The SessionState instance of the shared keyed-
// validator registry (validator-registry.ts): the click protocol's `set-state`
// verb writes only what's registered here, paired with the per-key validator
// that decides whether a raw incoming string is a legal value for that key.
// Adding a new state-writable key is one entry in this table — no new verb,
// no scattered string-matching, no defensive guard in the dispatcher.
//
// [LAW:one-source-of-truth] The registered keys ARE the schema for what
// SessionState mutations the click protocol can perform. Unknown-key
// rejection lists these names — operators see exactly the surface they're
// allowed to write.
//
// [LAW:one-type-per-behavior] The spec algebra (DerivedValidatorSpec,
// mergeKeySpecs, the registry's register/validate/dispose lifecycle) lives in
// validator-registry.ts, shared verbatim with config-validators.ts (the
// `persist` action's keyspace) — two keyspaces, one mechanism.

import { listResolvablePaletteNames, STRIP_STYLES } from "../../themes/policy";
import type { ActionDecl } from "../../config/action";
import {
  perConfigDomainsFor,
  resolveOptionDomain,
} from "../../config/option-domain";
import type { DslConfig } from "../../config/dsl-types";
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
// [LAW:locality-or-seam] Re-exported for existing test/consumer imports — the
// builder is generic (validator-registry.ts owns it), but state-validators.ts
// stays a stable barrel so nothing outside this module needs to know the
// factory moved.
export {
  makeAllowListValidator,
  makeIntValidator,
  makeRangeValidator,
} from "./validator-registry";

// [LAW:one-source-of-truth] listResolvablePaletteNames is THE set whose
// members resolve to a concrete Palette. It deliberately excludes the "custom"
// sentinel (which needs inline colors and is not a renderable theme name):
// accepting "custom" here would persist an unrenderable value into SessionState
// and break the next render.
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

// [LAW:dataflow-not-control-flow] Boolean-ish accepts exactly four canonical
// inputs and normalizes to two canonical outputs: truthy ("1"/"true") → "1",
// falsy ("0"/"false") → "" (empty). The empty falsy sentinel matches what
// `toolbar-toggle` produces via `clear()` for the next render.
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

// [LAW:one-source-of-truth] THE SessionState instance of the shared registry.
// Baseline keys (style/theme/toolbar-expanded) are legacy widget-era targets
// that predate the action-table-driven world and stay permanent; every other
// SessionState key is fully derived from a config's action table.
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

// [LAW:one-source-of-truth] The ONE place mapping a decoupled ACTION to the
// validator key SPEC it declares, for `set` (SessionState) actions. See
// config-validators.ts's actionKeySpecs for the `persist` (config-overrides)
// twin — same shape, different action key and target keyspace.
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

// [LAW:single-enforcer] A STRUCTURAL spec (menu int / stepper range) is
// always kept — even on a baseline key — so a collision throws loudly at
// registration rather than silently shadowing the permanent gate. Only an
// ALLOW-LIST contribution to a baseline key is dropped (the click reuses the
// baseline gate as intended).
//
// [LAW:one-source-of-truth] The baseline set is read from the registry that
// owns it (registry.listBaselineKeys()), not re-declared here — the baseline
// keys were passed to createValidatorRegistry above; a second hardcoded list
// could silently drift from them if a future baseline key were added there
// and forgotten here.
function dropBaselineAllowLists(
  contributions: readonly KeySpecContribution[],
): KeySpecContribution[] {
  const baseline = new Set(registry.listBaselineKeys());
  return contributions.filter(
    (c) => c.spec.kind !== "allow-list" || !baseline.has(c.key),
  );
}

// [LAW:one-source-of-truth] Each `state` variable's integer `default` is the
// initial value of its key — the value the bar renders before any click. The
// step-state handler must seed an unset key from the SAME number, so the
// derived range spec carries it.
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
  return seeds;
}

// [LAW:one-source-of-truth] The writable-key surface a config's `set` actions
// need, DERIVED from the action table — the same declarations the
// `{{ action }}` fn realizes a click from are the gate the wire enforces.
function actionContributions(config: DslConfig): KeySpecContribution[] {
  const seeds = stateKeySeeds(config);
  const perConfigDomains = perConfigDomainsFor(config.looks);
  return dropBaselineAllowLists(
    Object.values(config.actions).flatMap((a) =>
      actionKeySpecs(a, seeds, perConfigDomains),
    ),
  );
}

// [LAW:single-enforcer] The SOLE install-site derivation: a config's
// SessionState-writable-key surface is the merge of every `set` ACTION it
// declares, through ONE coherence pass.
export function deriveActionValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions(actionContributions(config));
}
