// [LAW:single-enforcer] THE load check over every session key a config
// authors: a `state` variable's key, a `set` action's target, a group's shared
// key and a `{{ menu }}`'s accordion key, from a file or a plugin alike.
//
// A raw key is the session key itself. The bar mints every key of its own
// (edit mode's, a placement's drafts, the menus and accordions it
// synthesizes, a click's error) under a reserved namespace, so a raw key
// there could write or read one of them, and is refused naming the namespace;
// a raw key anywhere else meets no minted key. An accordion key is spelled
// into a menu key of its own, which meets a minted one only when it is edit
// mode's (its writes would end with an edit) or the settings menu's own
// accordion, so only those are refused.

import type { Mutable, ValidateCtx } from "./validate-core.js";
import type { RawDslConfig } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import { declarationsAt } from "./refs.js";
import { sharedMenuStateKey } from "../menu-keys.js";
import { isEditModeKey, reservedNamespaceOf } from "../reserved-names.js";
import { SETTINGS_ACCORDIONS } from "../settings-menu.js";

// A session key as written, at the config path that writes it.
export interface AuthoredKey {
  readonly path: string;
  readonly key: string;
}

export function refuseMintedKeys(
  ctx: ValidateCtx,
  out: Readonly<Mutable<RawDslConfig>>,
  accordions: readonly AuthoredKey[],
): void {
  const declared = declarationsAt({
    variables: out.variables ?? {},
    segments: out.segments ?? {},
  });
  const raw: AuthoredKey[] = [
    ...[...declared].flatMap(([, decl, at]) =>
      decl.kind === "state"
        ? [{ path: [...at, "key"].join("."), key: decl.key }]
        : [],
    ),
    ...Object.entries(out.actions ?? {}).flatMap(([name, action]) =>
      "set" in action ? [{ path: `actions.${name}.set`, key: action.set }] : [],
    ),
    ...ctx.groups.flatMap((g) =>
      g.key === undefined ? [] : [{ path: `${g.path}.key`, key: g.key }],
    ),
  ];
  const refuse = ({ path, key }: AuthoredKey, why: string): void => {
    ctx.issues.push({
      path,
      message: `session key "${key}" ${why} — rename it`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
  };
  for (const authored of raw) {
    const ns = reservedNamespaceOf(authored.key);
    if (ns !== undefined)
      refuse(
        authored,
        `is in the "${ns}" namespace, where the bar mints its own keys, so it could read or overwrite one of them`,
      );
  }
  for (const authored of accordions) {
    const state = sharedMenuStateKey(authored.key);
    const ns = reservedNamespaceOf(authored.key);
    if (isEditModeKey(state))
      refuse(
        authored,
        `names an accordion in the "${ns}" namespace, edit mode's, whose state ends with every edit`,
      );
    else if (SETTINGS_ACCORDIONS.has(state))
      refuse(
        authored,
        `names the settings menu's own accordion, in the "${ns}" namespace`,
      );
  }
}
