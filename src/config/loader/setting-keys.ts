// [LAW:single-enforcer] One key has one owner. A setting owns its session
// key (src/config/setting-table.ts) and reads it through its domain, while a
// `state` variable reads whatever is stored — so a `state` variable over a
// setting's key would show a pick the setting reads as stale, and the bar
// and that variable would disagree. Refused at load. A placement setting's
// key sits in edit mode's namespace, which the authored-keys check refuses
// for every authored key before this one runs, so this check is the globals'.

import type { DslConfig } from "../dsl-types.js";
import { settingTable } from "../setting-table.js";
import { findKeyLine } from "./diagnostics.js";
import type { ValidateCtx } from "./validate-core.js";

export function refuseSettingKeyOwners(
  ctx: ValidateCtx,
  config: DslConfig,
): void {
  const { rows } = settingTable(config);
  const declared = [
    ...Object.entries(config.variables).map(
      ([name, decl]) => [["variables", name], decl] as const,
    ),
    ...Object.entries(config.segments).flatMap(([seg, decl]) =>
      Object.entries(decl.vars ?? {}).map(
        ([name, v]) => [["segments", seg, "vars", name], v] as const,
      ),
    ),
  ];
  for (const [at, decl] of declared) {
    if (decl.kind !== "state") continue;
    const row = rows.get(decl.key);
    if (row === undefined) continue;
    ctx.issues.push({
      path: [...at, "key"].join("."),
      message: `${at.join(".")}: a state variable reads "${decl.key}", which is the session key of setting ${row.name} — the setting owns it; read the setting's value instead`,
      line: findKeyLine(ctx.source, [...at, "key"]),
    });
  }
}
