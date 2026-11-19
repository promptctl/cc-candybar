// What a stepped key shows before any click or write. Seeds read a session's
// picks and the setting projections, so they sit with the verbs that step keys,
// above the gates (foundations/), which a seed would otherwise pull upward.

import {
  settingSpelling,
  stateVarDecls,
  type DslConfig,
  type Globals,
} from "../../config/dsl-types";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import { placementValue, settingTable } from "../../config/setting-table";
import { sessionSettingValue } from "../setting-drafts";

// [LAW:one-source-of-truth] What a stepped SessionState key shows — the value
// a step moves from — in the session whose config and picks these are. A
// setting shows what its one parse resolves to, a stale pick included: the
// global setting's value under the session's preset (sessionSettingValue),
// a placement setting's variable value. A plain key holds no domain, so it
// shows its stored integer, else its `state` variable's `default`. null when
// the config declares none of these.
export function stateKeyShows(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  key: string,
): string | null {
  const setting = settingTable(config).byKey.get(key);
  if (setting !== undefined) {
    // A global setting resolves through the session's whole fold; a
    // placement's through its own parse over its saved value.
    return setting.kind === "global"
      ? sessionSettingValue(config, sessionPick, setting.name)
      : settingSpelling(placementValue(setting, sessionPick(key)));
  }
  const stored = sessionPick(key);
  if (stored !== null && STEP_INT_RE.test(stored)) return stored;
  for (const [, decl] of stateVarDecls(config)) {
    if (decl.key === key) return decl.default ?? null;
  }
  return null;
}

// [LAW:single-enforcer] One integer-shape boundary, mirroring the range
// validator's canonical `^-?\d+$`: a step's `by` delta and a plain key's
// stored value are integers or they are not values.
export const STEP_INT_RE = /^-?\d+$/;

// [LAW:one-source-of-truth] What a stepped config key holds before the file
// declares it: the field in the globals the bar renders under its preset, or
// the field's floor (numericGlobalsSeeds). null for a key that is no numeric globals field.
export function configKeySeed(globals: Globals, key: string): string | null {
  const seed = numericGlobalsSeeds(globals).get(key);
  return seed === undefined ? null : String(seed);
}
