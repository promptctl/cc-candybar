// [LAW:one-source-of-truth] The persistent-config-write instance of the
// shared keyspace (validator-registry.ts) — the twin of
// state-validators.ts for `persist` actions instead of `set` actions.
// Gates stay derived the same way as session writes: a `persist` action
// carries its target key and value SOURCE as literal data, so the
// writable-key gate DERIVES from the action table exactly like
// stateGate does for `set`. No baseline keys: every config
// globals field becomes writable ONLY when a config declares a `persist`
// action for it — the epic's "zero engine edits to add a menu-able field"
// goal, realized more strictly here than SessionState's legacy baseline
// theme/endcaps/toolbar-expanded keys.

import type { ActionDecl } from "../../config/action";
import {
  resolveOptionDomain,
  type ResolvedDomain,
} from "../../config/option-domain";
import { configOptionDomains } from "../../config/edit-chrome";
import type { DslConfig, Globals } from "../../config/dsl-types";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import { encodeLayoutOp } from "../../config/layout-ops";
import {
  parsePersistTarget,
  presetRootKey,
} from "../../config/loader/persist-target";
import {
  createKeyspace,
  mergeContributions,
  type Gate,
  type KeySpecContribution,
} from "./validator-registry";

// [LAW:no-silent-fallbacks] No built-in keys: a config globals field is
// writable ONLY when some `persist` action names it.
const keyspace = createKeyspace({}, "config", deriveConfigActionValidators);

// A config key every session may write, whatever config it renders.
export function registerConfigValidator(
  key: string,
  allowed: readonly string[],
): () => void {
  return keyspace.register(key, allowed);
}

// [LAW:single-enforcer] The gate every durable write passes: the config-file
// writes the sessions rendering `config` may make — what its action table
// derives, over the daemon-wide keys.
export function configGate(config: DslConfig): Gate {
  return keyspace.gateFor(config);
}

// [LAW:one-source-of-truth] The ONE place mapping a `persist` ACTION to the
// validator key SPEC it declares — the mirror of state-validators.ts's
// actionKeySpecs for `set`. `persist` has no `int` arm: a page cursor is a
// UI-only paging concept with no meaning as a persisted config default.
function actionKeySpecs(
  a: ActionDecl,
  perConfigDomains: ReadonlyMap<string, ResolvedDomain>,
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
          allowed: resolveOptionDomain(a.from, perConfigDomains).members,
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
  // same "presets.<name>.root" key each contribute one allow-list member,
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
          ).members.map((segment) =>
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
      spec: { kind: "range", min: a.min, max: a.max },
    },
  ];
}

// [LAW:one-source-of-truth] What a stepped config key holds before the file
// declares it: the field in the globals the bar renders under its preset, or
// the field's floor (numericGlobalsSeeds). null for a key that is no numeric globals field.
export function configKeySeed(globals: Globals, key: string): string | null {
  const seed = numericGlobalsSeeds(globals).get(key);
  return seed === undefined ? null : String(seed);
}

// [LAW:one-source-of-truth] Every key a config's action table can CLEAR is a
// key of its gate, so `reset-config`'s membership check
// (src/daemon/verbs/index.ts's resetConfig) passes for exactly the keys some
// declared action targets — a `reset` names its key outright, and a structural
// `persist` on `presets.<name>.root` makes that root a key its own reset may
// empty. Membership rides on the reset itself, never on a sibling write action
// happening to name the same key: the settings menu's ↺ targets fields no
// action writes by click (a save writes them — src/daemon/setting-drafts.ts),
// and a preset edited down to zero addable segments contributes no layout op
// for its root, yet its reset must still resolve.
//
// An EMPTY allow-list contributes the key without granting any WRITE: a real
// write still needs a real action elsewhere, and mergeKeySpecs unions an empty
// array with whatever those contribute, whatever their kind.
//
// [LAW:no-mode-explosion] A config with no reset and no structural persist
// contributes nothing here, preserving this module's "zero baseline keys" floor
// (a key is writable or clearable only because SOME action names it).
function clearableContributions(config: DslConfig): KeySpecContribution[] {
  const keys = new Set<string>();
  for (const a of Object.values(config.actions)) {
    if ("reset" in a) keys.add(a.reset);
    const target = "persist" in a ? parsePersistTarget(a.persist) : null;
    if (target?.scope === "preset-root") keys.add(presetRootKey(target.preset));
  }
  return [...keys].map((key) => ({
    key,
    spec: { kind: "allow-list", allowed: [] },
  }));
}

function actionContributions(config: DslConfig): KeySpecContribution[] {
  const perConfigDomains = configOptionDomains(config);
  return [
    ...clearableContributions(config),
    ...Object.values(config.actions).flatMap((a) =>
      actionKeySpecs(a, perConfigDomains),
    ),
  ];
}

// [LAW:single-enforcer] The SOLE derivation: what a config contributes to its
// sessions' config-file gate is the merge of every `persist` ACTION it
// declares, through the SAME coherence pass deriveActionValidators uses for
// `set`.
export function deriveConfigActionValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions(actionContributions(config), "config");
}
