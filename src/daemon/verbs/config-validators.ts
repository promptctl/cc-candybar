// [LAW:one-source-of-truth] The persistent-config-write instance of the
// shared keyed-validator registry (validator-registry.ts) — the twin of
// state-validators.ts for `persist` actions instead of `set` actions.
// Gates stay derived the same way as session writes: a `persist` action
// carries its target key and value SOURCE as literal data, so the
// writable-key gate DERIVES from the action table exactly like
// deriveActionValidators does for `set`. No baseline keys: every config
// globals field becomes writable ONLY when a config declares a `persist`
// action for it — the epic's "zero engine edits to add a menu-able field"
// goal, realized more strictly here than SessionState's legacy baseline
// theme/style/toolbar-expanded keys.

import type { ActionDecl } from "../../config/action";
import {
  perConfigDomainsFor,
  resolveOptionDomain,
} from "../../config/option-domain";
import { addableSegmentDomains } from "../../config/edit-chrome";
import type { DslConfig } from "../../config/dsl-types";
import { isGlobalsField } from "../config-overrides-store";
import { encodeLayoutOp } from "../../config/layout-ops";
import {
  clampSeed,
  createValidatorRegistry,
  mergeContributions,
  type DerivedValidatorSpec,
  type KeySpecContribution,
  type RangeParams,
  type ValidateResult,
} from "./validator-registry";

// [LAW:no-silent-fallbacks] No baseline entries: a config globals field is
// writable ONLY when some `persist` action names it.
const registry = createValidatorRegistry({}, "config");

export function listConfigKeys(): readonly string[] {
  return registry.listKeys();
}

export function validateConfigWrite(
  key: string,
  rawValue: string,
): ValidateResult {
  return registry.validate(key, rawValue);
}

export function rangeParamsForConfig(key: string): RangeParams | null {
  return registry.rangeParamsFor(key);
}

// [LAW:one-source-of-truth] The ONE place mapping a `persist` ACTION to the
// validator key SPEC it declares — the mirror of state-validators.ts's
// actionKeySpecs for `set`. `persist` has no `int` arm: a page cursor is a
// UI-only paging concept with no meaning as a persisted config default.
function actionKeySpecs(
  a: ActionDecl,
  seeds: ReadonlyMap<string, number>,
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): KeySpecContribution[] {
  if (!("persist" in a)) return [];
  if ("to" in a) {
    return [{ key: a.persist, spec: { kind: "allow-list", allowed: [a.to] } }];
  }
  if ("from" in a) {
    return [
      {
        key: a.persist,
        spec: {
          kind: "allow-list",
          allowed: resolveOptionDomain(a.from, perConfigDomains),
        },
      },
    ];
  }
  if ("cycle" in a) {
    return [{ key: a.persist, spec: { kind: "allow-list", allowed: a.cycle } }];
  }
  // [LAW:single-enforcer] brandon-layout-edit-2gc.1's structural-edit arms:
  // the op is fully literal at config-author time (removeSegment's target,
  // insertSegment's segment/anchor/relation), so — exactly like a literal
  // `to` — there is exactly ONE legal value this declared action can ever
  // request: its own encoded op token. Multiple layout actions targeting the
  // same "presets.<name>.rootOps" key each contribute one allow-list member,
  // unioned by mergeContributions below, same as multiple `to` actions on
  // one key already do.
  if ("removeSegment" in a) {
    return [
      {
        key: a.persist,
        spec: {
          kind: "allow-list",
          allowed: [encodeLayoutOp({ op: "remove", target: a.removeSegment })],
        },
      },
    ];
  }
  if ("insertSegment" in a) {
    return [
      {
        key: a.persist,
        spec: {
          kind: "allow-list",
          allowed: [
            encodeLayoutOp({
              op: "insert",
              segment: a.insertSegment,
              anchor: a.anchor,
              relation: a.relation,
            }),
          ],
        },
      },
    ];
  }
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.3's domain-sourced
  // sibling: the allow-list is the ENCODED op token for every domain member,
  // not the raw member — mirroring how a literal `insertSegment` contributes
  // its own single encoded token above. A click carrying an option this
  // domain never named — or naming a real segment but the wrong anchor/
  // relation — cannot decode to a member of this list, so it is rejected the
  // same loud way an unknown literal op token already is.
  if ("insertSegmentFrom" in a) {
    return [
      {
        key: a.persist,
        spec: {
          kind: "allow-list",
          allowed: resolveOptionDomain(
            a.insertSegmentFrom,
            perConfigDomains,
          ).map((segment) =>
            encodeLayoutOp({
              op: "insert",
              segment,
              anchor: a.anchor,
              relation: a.relation,
            }),
          ),
        },
      },
    ];
  }
  return [
    {
      key: a.persist,
      spec: {
        kind: "range",
        min: a.min,
        max: a.max,
        seed: clampSeed(seeds.get(a.persist), a.min, a.max),
      },
    },
  ];
}

// [LAW:one-source-of-truth] The unset seed for a bounded `persist` key (e.g.
// a padding stepper) is the value that would render with NO override yet —
// the merged config's OWN globals field, before this reload's overrides are
// applied. Mirrors stateKeySeeds' "the bar's current display, not silently
// min" rule for SessionState steppers.
function configKeySeeds(config: DslConfig): ReadonlyMap<string, number> {
  const seeds = new Map<string, number>();
  for (const [key, value] of Object.entries(config.globals)) {
    if (isGlobalsField(key) && typeof value === "number") {
      seeds.set(key, value);
    }
  }
  return seeds;
}

function actionContributions(config: DslConfig): KeySpecContribution[] {
  const seeds = configKeySeeds(config);
  // [LAW:one-source-of-truth] The "addable segment" domains
  // (edit-chrome.ts's `addableSegmentDomains`) merge in here alongside
  // looks/presets — the same per-preset seam `insertSegmentFrom` resolves
  // through at render (render.ts's registerDslConfig merges the identical
  // map), so the rendered picker options and the derived click gate can
  // never diverge over what's addable.
  const perConfigDomains = new Map([
    ...perConfigDomainsFor(config),
    ...addableSegmentDomains(config),
  ]);
  return Object.values(config.actions).flatMap((a) =>
    actionKeySpecs(a, seeds, perConfigDomains),
  );
}

// [LAW:single-enforcer] The SOLE install-site derivation: a config's
// persistent-config-writable-key surface is the merge of every `persist`
// ACTION it declares, through the SAME coherence pass deriveActionValidators
// uses for `set`.
export function deriveConfigActionValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions(actionContributions(config), "config");
}

export function registerConfigValidator(
  key: string,
  spec: DerivedValidatorSpec,
): () => void {
  return registry.register(key, spec);
}
