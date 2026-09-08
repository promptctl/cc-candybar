// [LAW:single-enforcer] The ONE reserved-namespace collision check both synthesis
// passes run: group sugar owns `groups.`, the `{{ menu }}` helper owns `menus.`.

import type { Mutable, ValidateCtx } from "./validate-core.js";
import type { RawDslConfig } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";

// [LAW:no-silent-failure] Reject a user name under the prefix in all three sections BEFORE synthesis writes into them; `synthesizedBy` names the owning sugar.
export function reservedNamespaceCollisions(
  ctx: ValidateCtx,
  out: Mutable<RawDslConfig>,
  ns: string,
  synthesizedBy: string,
): void {
  for (const section of ["variables", "actions", "segments"] as const) {
    for (const name of Object.keys(out[section] ?? {})) {
      if (name.startsWith(ns)) {
        ctx.issues.push({
          path: `${section}.${name}`,
          message: `"${name}" is in the reserved "${ns}" namespace (synthesized by ${synthesizedBy}) — rename it`,
          line: findKeyLine(ctx.source, ["root"]),
        });
      }
    }
  }
}
