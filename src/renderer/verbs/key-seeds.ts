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
import { SESSION_KEY_TO_SETTING } from "../../config/setting-projections";
import { sessionSettingValue } from "../setting-drafts";

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

// [LAW:one-source-of-truth] What a stepped config key holds before the file
// declares it: the field in the globals the bar renders under its preset, or
// the field's floor (numericGlobalsSeeds). null for a key that is no numeric globals field.
export function configKeySeed(globals: Globals, key: string): string | null {
  const seed = numericGlobalsSeeds(globals).get(fieldOf(key));
  return seed === undefined ? null : String(seed);
}

// [LAW:one-source-of-truth] What a cycled config key holds before the file
// declares it: the field in the globals the bar renders under its preset,
// spelled as the bar spells a setting. null for a field those globals leave
// unset, or a key that names none, which a cycle counts as its first member.
export function configKeyShown(globals: Globals, key: string): string | null {
  const value: unknown = globals[fieldOf(key) as keyof Globals];
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? settingSpelling(value)
    : null;
}

// The globals field a config key names: the key spells where in the file the
// field lives (`presets.compact.globals.padding`).
function fieldOf(key: string): string {
  const target = parsePersistTarget(key);
  return target !== null && "field" in target ? target.field : key;
}
