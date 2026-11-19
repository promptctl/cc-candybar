// What a stepped key shows before any click or write. Seeds read a session's
// picks and the setting projections, so they sit with the verbs that step keys,
// above the gates (foundations/), which a seed would otherwise pull upward.

import {
  stateVarDecls,
  type DslConfig,
  type Globals,
} from "../../config/dsl-types";
import { numericGlobalsSeeds } from "../../config/loader/globals";
import { placementFold, settingTable } from "../../config/setting-table";
import { parseInteger } from "../../themes/policy";
import { sessionSetting } from "../setting-drafts";

// [LAW:one-source-of-truth] What a stepped SessionState key shows — the value
// a step moves from — in the session whose config and picks these are. A
// setting shows its fold's value, the one parse of its pick — a stale pick
// shows what the bar draws instead: the global setting's value under the
// session's preset (sessionSetting), a placement setting's own fold. A plain
// key holds no domain, so it shows its stored integer, else its `state`
// variable's `default`, through the one integer parse. null when the config
// declares none of these.
export function stateKeyShows(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  key: string,
): unknown {
  const setting = settingTable(config).byKey.get(key);
  if (setting !== undefined) {
    return setting.kind === "global"
      ? sessionSetting(config, sessionPick, setting.name)
      : placementFold(setting, sessionPick(key)).value;
  }
  const stored = sessionPick(key);
  const held = stored === null ? null : parseInteger(stored);
  if (held !== null) return held;
  for (const [, decl] of stateVarDecls(config)) {
    if (decl.key === key) {
      return decl.default === undefined
        ? null
        : (parseInteger(decl.default) ?? decl.default);
    }
  }
  return null;
}

// [LAW:one-source-of-truth] What a stepped config key holds before the file
// declares it: the field in the globals the bar renders under its preset, or
// the field's floor (numericGlobalsSeeds). null for a key that is no numeric globals field.
export function configKeySeed(globals: Globals, key: string): number | null {
  return numericGlobalsSeeds(globals).get(key) ?? null;
}
