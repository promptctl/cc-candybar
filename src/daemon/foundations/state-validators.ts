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
  isInstalledTheme,
  notInstalledTheme,
  ENDCAPS_SHAPES,
} from "../../themes/policy";
import type { ActionDecl } from "../../config/action";
import { configOptionDomains } from "../../config/edit-chrome";
import {
  resolveOptionDomain,
  type ResolvedDomain,
} from "../../config/option-domain";
import type { DslConfig } from "../../config/dsl-types";
import {
  createKeyspace,
  mergeContributions,
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

const RESOLVABLE_ENDCAPS: ReadonlySet<string> = new Set(ENDCAPS_SHAPES);

// [LAW:single-enforcer] A theme pick is admitted by the installed set's one
// membership test, the same one a stored theme is read through, so a click
// cannot store a name the bar would then report as stale. "custom" is no member
// (it needs inline colors and names no palette).
const validateTheme: KeyValidator = (raw) => {
  if (!raw) return { ok: false, reason: "theme name is required" };
  if (!isInstalledTheme(raw)) {
    return {
      ok: false,
      reason: notInstalledTheme(raw),
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

// [LAW:one-source-of-truth] The built-in keys (endcaps/theme):
// legacy widget-era targets that predate the action-table-driven world and
// stay writable in every session; every other SessionState key is derived
// from the session's config's action table.
const BASELINE: Readonly<Record<string, KeyValidator>> = {
  endcaps: validateEndcaps,
  theme: validateTheme,
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

// [LAW:single-enforcer] A STRUCTURAL spec (menu int / stepper range) is
// always kept — even on a built-in key — so a collision throws loudly when
// the gate is built rather than silently shadowing the built-in gate. Only an
// ALLOW-LIST contribution to a built-in key is dropped (the click reuses the
// built-in gate as intended).
function dropBaselineAllowLists(
  contributions: readonly KeySpecContribution[],
): KeySpecContribution[] {
  return contributions.filter(
    (c) => c.spec.kind !== "allow-list" || !Object.hasOwn(BASELINE, c.key),
  );
}

// [LAW:one-source-of-truth] The writable-key surface a config's `set` actions
// need, DERIVED from the action table — the same declarations the
// `{{ action }}` fn realizes a click from are the gate the wire enforces, and
// the domains a `state` variable reads its key through (state-fold.ts).
export function actionContributions(config: DslConfig): KeySpecContribution[] {
  const perConfigDomains = configOptionDomains(config);
  return dropBaselineAllowLists(
    Object.values(config.actions).flatMap((a) =>
      actionKeySpecs(a, perConfigDomains),
    ),
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
