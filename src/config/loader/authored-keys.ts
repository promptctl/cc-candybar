// [LAW:single-enforcer] THE load check over every session key a config
// authors: a `state` variable's key, a `set` action's target, a group's shared
// key and a `{{ menu }}`'s accordion key. The bar mints its own keys (edit
// mode's, a placement's drafts, the menus and accordions it synthesizes)
// under its reserved namespaces, so an authored key there could write or
// read one of them, and is refused naming the namespace. A key anywhere else
// meets no minted key, because every minted key is spelled under one of them.

import type { Mutable, ValidateCtx } from "./validate-core.js";
import type { RawDslConfig } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import { authoredMenuKeys } from "./menu-synth.js";
import { reservedNamespaceOf } from "../reserved-names.js";

export function refuseMintedKeys(
  ctx: ValidateCtx,
  out: Readonly<Mutable<RawDslConfig>>,
): void {
  const variables = [
    ...Object.entries(out.variables ?? {}).map(
      ([name, decl]) => [`variables.${name}`, decl] as const,
    ),
    ...Object.entries(out.segments ?? {}).flatMap(([seg, decl]) =>
      Object.entries(decl.vars ?? {}).map(
        ([name, v]) => [`segments.${seg}.vars.${name}`, v] as const,
      ),
    ),
  ];
  const keys = [
    ...variables.flatMap(([path, decl]) =>
      decl.kind === "state" ? [{ path: `${path}.key`, key: decl.key }] : [],
    ),
    ...Object.entries(out.actions ?? {}).flatMap(([name, action]) =>
      "set" in action ? [{ path: `actions.${name}.set`, key: action.set }] : [],
    ),
    ...ctx.groups.flatMap((g) =>
      g.key === undefined ? [] : [{ path: `${g.path}.key`, key: g.key }],
    ),
    ...authoredMenuKeys(out).map(({ path, key }) => ({
      path: `${path}.template`,
      key,
    })),
  ];
  for (const { path, key } of keys) {
    const ns = reservedNamespaceOf(key);
    if (ns === undefined) continue;
    ctx.issues.push({
      path,
      message: `session key "${key}" is in the "${ns}" namespace, where the bar mints its own keys — an authored key there could read or overwrite one of them; rename it`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
  }
}
