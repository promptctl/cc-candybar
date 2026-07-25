// [LAW:one-source-of-truth] The loader-side half of the disclosure primitive
// (src/config/disclosure.ts): the ONE reserved-namespace collision check both
// synthesis passes run. Group sugar reserves `groups.` and the `{{ menu }}`
// helper reserves `menus.`; each synthesizes its `state` var, `cycle` action, and
// (for a group) a toggle segment under its prefix, so a user-authored name under
// that prefix must be a loud load error — never a silent overwrite of a
// synthesized artifact. The check was duplicated verbatim in both passes; it lives
// here now, parameterized by the prefix and a human description of what
// synthesizes it, so the two body-kinds share one enforcer [LAW:single-enforcer].

import type { Mutable, ValidateCtx } from "./validate-core.js";
import type { RawDslConfig } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";

// [LAW:no-silent-failure] Reject every user name under the reserved prefix across
// all three declaration sections (a synthesized disclosure lands in each), before
// synthesis writes into them — so a `groups.*`/`menus.*` squatter surfaces as a
// rename-pointing error rather than being silently shadowed. `synthesizedBy`
// names the feature in the message (e.g. "group nodes", "{{ menu }} helpers") so
// the author knows which sugar owns the prefix.
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
