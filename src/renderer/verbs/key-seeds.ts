// What a stepped key shows, which a step moves from. Seeds read a session's
// picks and the setting projections, so they sit with the verbs that step keys,
// above the gates (foundations/), which a seed would otherwise pull upward.

import {
  settingSpelling,
  stateVarDecls,
  type DslConfig,
  type Globals,
} from "../../config/dsl-types";
import { placementFold, settingTable } from "../../config/setting-table";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import { parsePersistTarget } from "../../config/loader/persist-target";
import {
  CONFIG_KEY_TO_SETTING,
  SESSION_KEY_TO_SETTING,
  configOnlyField,
} from "../../config/setting-projections";
import { sessionConfigOnlyValue, sessionSettingValue } from "../setting-drafts";

// [LAW:one-source-of-truth] What a stepped SessionState key shows, in the
// session whose config and picks these are — what a step moves from. A
// setting's is its fold (a globals setting's under the session's preset,
// sessionSettingValue; a placement's over its value), so a stale pick steps
// from the value the bar wears; any other key's is what the session holds,
// else its `state` variable's `default`. null when the config declares none.
export function stateKeyShown(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  key: string,
): string | null {
  const setting = SESSION_KEY_TO_SETTING.get(key);
  if (setting !== undefined) {
    return sessionSettingValue(config, sessionPick, setting);
  }
  const placement = settingTable(config).placements.find((p) => p.key === key);
  if (placement !== undefined) {
    return settingSpelling(placementFold(placement, sessionPick(key)).value);
  }
  for (const [, decl] of stateVarDecls(config)) {
    if (decl.key === key) return sessionPick(key) ?? decl.default ?? null;
  }
  return sessionPick(key);
}

// [LAW:one-source-of-truth] What a persisted key shows: the value the bar
// wears for the setting it writes (the `.effective` a persist action reads
// back through), else what a declared `state` variable over the key holds. A
// persist key with neither shows nothing, as its read-back variable holds
// nothing on the draw.
export function configKeyShown(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  key: string,
): string | null {
  const setting = CONFIG_KEY_TO_SETTING.get(key);
  if (setting !== undefined) {
    return sessionSettingValue(config, sessionPick, setting);
  }
  const field = configOnlyField(key);
  if (field !== undefined) {
    return sessionConfigOnlyValue(config, sessionPick, field);
  }
  return stateKeyShown(config, sessionPick, key);
}

// [LAW:one-source-of-truth] What a stepped config key holds before the file
// declares it: the field in the globals the bar renders under its preset, or
// the field's floor (numericGlobalsSeeds). null for a key that is no numeric globals field.
export function configKeySeed(globals: Globals, key: string): string | null {
  // The seeds are named by field, and the key spells where in the file the
  // field lives (`presets.compact.globals.padding`).
  const target = parsePersistTarget(key);
  const seed = numericGlobalsSeeds(globals).get(
    target !== null && "field" in target ? target.field : key,
  );
  return seed === undefined ? null : String(seed);
}
