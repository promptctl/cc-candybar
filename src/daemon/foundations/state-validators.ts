// [LAW:single-enforcer] The SessionState instance of the shared keyspace
// (validator-registry.ts): the click protocol's `set-state` verb writes only
// what the clicking session's gate holds, paired with the per-key validator
// that decides whether a raw incoming string is a legal value for that key.
// Adding a new state-writable key is one action in a config — no new verb,
// no scattered string-matching, no defensive guard in the dispatcher.
//
// [LAW:one-source-of-truth] A gate's keys ARE the schema for what
// SessionState mutations a click in that session can perform. Unknown-key
// rejection lists these names — operators see exactly the surface they're
// allowed to write.
//
// [LAW:one-type-per-behavior] The spec algebra (DerivedValidatorSpec,
// mergeKeySpecs, the keyspace and the gates it derives) lives in
// validator-registry.ts, shared verbatim with config-validators.ts (the
// `persist` action's keyspace) — two keyspaces, one mechanism.

import {
  listResolvablePaletteNames,
  ENDCAPS_SHAPES,
} from "../../themes/policy";
import type { ActionDecl } from "../../config/action";
import { configOptionDomains } from "../../config/edit-chrome";
import {
  resolveOptionDomain,
  type ResolvedDomain,
} from "../../config/option-domain";
import type { DslConfig } from "../../config/dsl-types";
import { describeMembers } from "../../config/setting-control";
import {
  createKeyspace,
  mergeContributions,
  type BuiltinKey,
  type Keyspace,
  type KeySpecContribution,
  type KeyValidator,
} from "./validator-registry";

export type {
  DerivedValidatorSpec,
  Gate,
  KeySpecContribution,
  KeyValidator,
  RangeParams,
  ValidateResult,
  Verdict,
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
const RESOLVABLE_ENDCAPS: ReadonlySet<string> = new Set(ENDCAPS_SHAPES);

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
      reason: `unknown endcaps "${raw}" (have: ${ENDCAPS_SHAPES.join(", ")})`,
    };
  }
  return { ok: true, value: raw };
};

// [LAW:dataflow-not-control-flow] Boolean-ish accepts exactly four canonical
// inputs and normalizes to two canonical outputs: truthy ("1"/"true") → "1",
// falsy ("0"/"false") → "" (empty). The empty falsy sentinel matches what
// `toolbar-toggle` produces via `clear()` for the next render.
// [LAW:types-are-the-program] "" is also an input: every validator accepts
// its own output unchanged, so a stored false reads back as held
// (Gate.verdict). That makes this the one validator that admits an empty
// value — it is its own canonical false, where "0" would read as true in a
// template — and it stores exactly what "0" and "false" store.
const BOOLEAN_TRUTHY = new Set(["1", "true"]);
const BOOLEAN_FALSY = new Set(["", "0", "false"]);
const validateBoolean: KeyValidator = (raw) => {
  if (BOOLEAN_TRUTHY.has(raw)) return { ok: true, value: "1" };
  if (BOOLEAN_FALSY.has(raw)) return { ok: true, value: "" };
  return {
    ok: false,
    reason: `expected boolean-ish (1, 0, true, false), got "${raw}"`,
  };
};

// [LAW:one-source-of-truth] The built-in keys (endcaps/theme/toolbar-expanded):
// legacy widget-era targets that predate the action-table-driven world and
// stay writable in every session; every other SessionState key is derived
// from the session's config's action table.
const BASELINE: Readonly<Record<string, BuiltinKey>> = {
  endcaps: {
    validate: validateEndcaps,
    admits: describeMembers(ENDCAPS_SHAPES),
  },
  theme: {
    validate: validateTheme,
    admits: describeMembers(RESOLVABLE_THEMES_LIST, "themes"),
  },
  "toolbar-expanded": { validate: validateBoolean, admits: "true or false" },
};

// [LAW:no-shared-mutable-globals] A SessionState keyspace is a value the root
// builds (gates.ts) and passes in: the keys a daemon holds are its own.
export function makeStateKeyspace(): Keyspace<DslConfig> {
  return createKeyspace(BASELINE, "state", deriveActionValidators);
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

// [LAW:one-source-of-truth] The writable-key surface a config's `set` actions
// need, DERIVED from the action table — the same declarations the
// `{{ action }}` fn realizes a click from are the gate the wire enforces.
function actionContributions(config: DslConfig): KeySpecContribution[] {
  const perConfigDomains = configOptionDomains(config);
  return Object.values(config.actions).flatMap((a) =>
    actionKeySpecs(a, perConfigDomains),
  );
}

// [LAW:single-enforcer] The SOLE derivation: what a config contributes to its
// sessions' SessionState gate is the merge of every `set` ACTION it declares,
// through ONE coherence pass.
export function deriveActionValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions(actionContributions(config));
}
