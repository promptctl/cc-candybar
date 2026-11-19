// What a stepped key shows, which a step steps from. They read a session's
// picks and the setting projections, so they sit with the verbs that step keys,
// above the gates (foundations/), which a seed would otherwise pull upward.

import {
  stateVarDecls,
  type DslConfig,
  type Globals,
} from "../../config/dsl-types";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import { SESSION_KEY_TO_SETTING } from "../../config/setting-projections";
import {
  effectiveGlobal,
  parseSessionInt,
  readStored,
  type Folded,
} from "../../themes/policy";
import type { RangeParams } from "../../daemon/foundations/validator-registry";
import { draftSlotShows, settingShows } from "../setting-drafts";

// [LAW:one-source-of-truth] What a stepped SessionState key shows, in the
// session whose config and picks these are — what a step steps from, with the
// stored spelling it passed over. A setting's is its fold in the session's
// full resolution, edit mode's staged value included, and a placement setting
// draft slot's is its slot's fold: the values the bar and the control show.
// Any other key's is its stored value read against its range, over its
// `state` variable's `default`, so a stored value out of range is a miss, as
// a setting's is. A null value: the config declares no value for the key.
export function stateKeyShows(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  key: string,
  range: RangeParams,
): Folded<string | null> {
  const setting = SESSION_KEY_TO_SETTING.get(key);
  if (setting !== undefined) return settingShows(config, sessionPick, setting);
  return (
    draftSlotShows(config, sessionPick, key) ??
    effectiveGlobal<string | null>(
      undefined,
      readStored(sessionPick(key), (raw) =>
        parseSessionInt(raw, range) === null ? null : raw,
      ),
      stateDefault(config, key),
      null,
    )
  );
}

function stateDefault(config: DslConfig, key: string): string | null {
  for (const [, decl] of stateVarDecls(config)) {
    if (decl.key === key) return decl.default ?? null;
  }
  return null;
}

// [LAW:one-source-of-truth] What a stepped config key holds before the file
// declares it: the field in the globals the bar renders under its preset, or
// the field's floor (numericGlobalsSeeds). null for a key that is no numeric globals field.
export function configKeySeed(globals: Globals, key: string): string | null {
  const seed = numericGlobalsSeeds(globals).get(key);
  return seed === undefined ? null : String(seed);
}
