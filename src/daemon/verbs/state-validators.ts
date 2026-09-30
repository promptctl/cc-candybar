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
  type ResolvedDomain,
} from "../../config/option-domain";
import type { DslConfig } from "../../config/dsl-types";
import { SESSION_KEY_TO_SETTING } from "../../config/setting-projections";
import { sessionSettingValue } from "../setting-drafts";
import {
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
const RESOLVABLE_ENDCAPS: ReadonlySet<string> = new Set(STRIP_STYLES);

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

const validateEndcaps: KeyValidator = (raw) => {
  if (!raw) return { ok: false, reason: "endcaps name is required" };
  if (!RESOLVABLE_ENDCAPS.has(raw)) {
    return {
      ok: false,
      reason: `unknown endcaps "${raw}" (have: ${STRIP_STYLES.join(", ")})`,
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
// Baseline keys (endcaps/theme/toolbar-expanded) are legacy widget-era targets
// that predate the action-table-driven world and stay permanent; every other
// SessionState key is fully derived from a config's action table.
const registry = createValidatorRegistry({
  endcaps: validateEndcaps,
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
// config-validators.ts's actionKeySpecs for the `persist` (config-file)
// twin — same shape, different action key and target keyspace.
function actionKeySpecs(
  a: ActionDecl,
  perConfigDomains: ReadonlyMap<string, ResolvedDomain>,
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
          allowed: resolveOptionDomain(a.from, perConfigDomains).members,
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
      spec: { kind: "range", min: a.min, max: a.max },
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

// [LAW:one-source-of-truth] What a stepped SessionState key shows before any
// click, in the session whose config and picks these are: a setting's is the
// value the session's preset resolves it to (sessionSettingValue — the bar and
// its control show the same); any other key's is its `state` variable's
// `default`. null when the config declares neither.
export function stateKeySeed(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  key: string,
): string | null {
  const setting = SESSION_KEY_TO_SETTING.get(key);
  if (setting !== undefined) {
    return sessionSettingValue(config, sessionPick, setting);
  }
  const decl = Object.values(config.variables).find(
    (d) => d.kind === "state" && d.key === key,
  );
  return decl?.kind === "state" ? (decl.default ?? null) : null;
}

// [LAW:one-source-of-truth] The writable-key surface a config's `set` actions
// need, DERIVED from the action table — the same declarations the
// `{{ action }}` fn realizes a click from are the gate the wire enforces.
function actionContributions(config: DslConfig): KeySpecContribution[] {
  const perConfigDomains = perConfigDomainsFor(config);
  return dropBaselineAllowLists(
    Object.values(config.actions).flatMap((a) =>
      actionKeySpecs(a, perConfigDomains),
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
