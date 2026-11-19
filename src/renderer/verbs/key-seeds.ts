// What a stepped key shows, which a step steps from. They read a session's
// picks and the setting projections, so they sit with the verbs that step keys,
// above the gates (foundations/), which a seed would otherwise pull upward.

import type { DslConfig, Globals, SettingValue } from "../../config/dsl-types";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import { SESSION_KEY_TO_SETTING } from "../../config/setting-projections";
import type { Folded } from "../../config/fold";
import { keyFold } from "../../config/state-fold";
import { settingShows } from "../setting-drafts";

// [LAW:one-source-of-truth] What a stepped SessionState key shows, in the
// session whose config and picks these are — what a step steps from, with the
// stored spelling it passed over. A setting's is its fold in the session's
// full resolution, edit mode's staged value included; any other key's is its
// `state` variable's fold: the values the bar and the control show.
export function stateKeyShows(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  key: string,
): Folded<SettingValue | null> {
  const setting = SESSION_KEY_TO_SETTING.get(key);
  return setting !== undefined
    ? settingShows(config, sessionPick, setting)
    : keyFold(config, key)(sessionPick(key));
}

// [LAW:one-source-of-truth] What a stepped config key holds before the file
// declares it: the field in the globals the bar renders under its preset, or
// the field's floor (numericGlobalsSeeds). null for a key that is no numeric globals field.
export function configKeySeed(globals: Globals, key: string): number | null {
  return numericGlobalsSeeds(globals).get(key) ?? null;
}
