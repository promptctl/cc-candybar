// What a stepped key shows before any click or write. Seeds read a session's
// picks and the setting projections, so they sit with the verbs that step keys,
// above the gates (foundations/), which a seed would otherwise pull upward.

import {
  stateVarDecls,
  type DslConfig,
  type Globals,
} from "../../config/dsl-types";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import { SESSION_KEY_TO_SETTING } from "../../config/setting-projections";
import { sessionSettingValue } from "../setting-drafts";

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
