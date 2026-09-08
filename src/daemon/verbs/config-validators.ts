// [LAW:one-source-of-truth] The persistent-config-write instance of the shared keyed-validator registry — the twin of state-validators.ts for `persist` instead of `set`, with the gate derived from the action table the same way.

import { actionDestinations, type ActionDecl } from "../../config/action";
import {
  perConfigDomainsFor,
  resolveOptionDomain,
} from "../../config/option-domain";
import { addableSegmentDomains } from "../../config/edit-chrome";
import type { DslConfig } from "../../config/dsl-types";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import { encodeLayoutOp } from "../../config/layout-ops";
import {
  parsePersistTarget,
  presetRootKey,
} from "../../config/loader/persist-target";
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

// [LAW:one-source-of-truth] The ONE mapping from a `persist` action to its validator key spec. `persist` has no `int` arm: a page cursor has no meaning as a persisted default.
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
  // [LAW:single-enforcer] The op is fully literal at author time, so there is exactly ONE legal value this action can request: its own encoded token, unioned with its siblings on the same key.
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
  // [LAW:one-source-of-truth] The allow-list is the ENCODED op token for every domain member, not the raw member, so an option this domain never named cannot decode into it.
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

// [LAW:one-source-of-truth] A bounded key's seed is the merged config's OWN globals field — the value the bar renders with today, never silently min.
function configKeySeeds(config: DslConfig): ReadonlyMap<string, number> {
  return numericGlobalsSeeds(config.globals);
}

// [LAW:one-source-of-truth] A preset root some persist OR reset action already targets stays registered even when its current tree contributes nothing, so a fully-emptied preset's own reset still resolves; the EMPTY allow-list registers the key without granting a write.
// [LAW:no-mode-explosion] Narrower than "every declared preset": with no persist/reset over it, a presets block registers nothing here.
function presetRootContributions(config: DslConfig): KeySpecContribution[] {
  const presets = new Set<string>();
  for (const a of writeDestinations(config)) {
    const key = "persist" in a ? a.persist : "reset" in a ? a.reset : null;
    if (key === null) continue;
    const target = parsePersistTarget(key);
    if (target?.scope === "preset-root") presets.add(target.preset);
  }
  return [...presets].map((name) => ({
    key: presetRootKey(name),
    spec: { kind: "allow-list", allowed: [] },
  }));
}

function actionContributions(config: DslConfig): KeySpecContribution[] {
  const seeds = configKeySeeds(config);
  // [LAW:one-source-of-truth] The same domain map `insertSegmentFrom` resolves through at render, so picker options and the derived click gate cannot diverge.
  const perConfigDomains = new Map([
    ...perConfigDomainsFor(config),
    ...addableSegmentDomains(config),
  ]);
  return [
    ...presetRootContributions(config),
    ...writeDestinations(config).flatMap((a) =>
      actionKeySpecs(a, seeds, perConfigDomains),
    ),
  ];
}

// [LAW:single-enforcer] The SAME explosion state-validators.ts folds over, so a dual-destination action contributes exactly its durable half's spec.
function writeDestinations(config: DslConfig): readonly ActionDecl[] {
  return Object.values(config.actions).flatMap(actionDestinations);
}

// [LAW:single-enforcer] The SOLE install-site derivation: the merge of every `persist` action, through the SAME coherence pass `set` uses.
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
