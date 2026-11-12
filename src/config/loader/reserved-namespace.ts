// [LAW:one-source-of-truth] The loader-side half of the disclosure primitive
// (src/config/disclosure.ts): the ONE reserved-namespace collision check both
// synthesis passes run. Group sugar reserves `groups.` and the `{{ menu }}`
// helper reserves `menus.`; each synthesizes its `state` var, `cycle` action, and
// (for a group) a toggle segment under its prefix, so a user-authored name under
// that prefix must be a loud load error — never a silent overwrite of a
// synthesized artifact. The check was duplicated verbatim in both passes; it lives
// here now, parameterized by the prefix and a human description of what
// synthesizes it, so the two body-kinds share one enforcer [LAW:single-enforcer].

import { ident } from "../ident.js";
import type { Mutable, ValidateCtx } from "./validate-core.js";
import type { RawDslConfig } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import { scopeOf } from "./plugin-scope.js";
import { RESERVED_NAMESPACES } from "../reserved-names.js";
import { PAYLOAD_INPUTS } from "../payload-inputs.js";

// [LAW:one-source-of-truth] The same reservation, asked in `ident()` SPACE — the
// question an authored name that never becomes a declaration has to answer. A
// `{{ menu }}` accordion key is such a name: it is a template argument, so
// `reservedNamespaceCollisions` below (which walks declaration sections) cannot
// see it, and `menuStateKey` collapses it through `ident()` before it becomes the
// state key. That collapse is where the reservation leaked: `candybar.pickers`,
// `candybar-pickers` and `candybar_pickers` all collapse to `candybar_pickers`,
// so all three derived the state key the settings menu's own picker accordion
// mints and JOINED it — opening a user menu closed the settings picker, with no
// error naming the cause (brandon-menus-du8).
//
// Comparing in ident() space is what closes the CLASS rather than a spelling
// [LAW:behavior-not-structure]: `ident()`'s codomain is `[A-Za-z0-9_]*`, so an
// authored name can only collide with a synthesized `ns + x` when its own
// collapse starts with `ident(ns)`. Testing the authored spelling for a leading
// `"candybar."` — the check the reviewer proposed — misses two of those three.
// Returns the namespace, so the caller's message can name what owns it.
export function reservedNamespaceOf(name: string): string | undefined {
  const collapsed = ident(name);
  return RESERVED_NAMESPACES.find((ns) => collapsed.startsWith(ident(ns)));
}

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

// [LAW:single-enforcer] A name whose owner is not the config file declaring
// it, refused by every config file alike. A plugin scope (`plugins`, `repo`) is
// a root plugins own: every name under it is declared by a plugin's own
// definition, and the payload carries its sources there. A config file's own
// declaration there — a variable named `repo`, an action `plugins.x.go`, a
// segment no plugin declares — would shadow a plugin or the payload, whichever
// scope that file's plugins load under. Only a variable can shadow the
// payload's root itself; a segment, action or helper named just `repo` sits
// beside every plugin's names — but a segment's own `vars` are variables named
// under it, so a segment `repo`'s var `lit` is `repo.lit`, a plugin's
// namespace, and is refused as one. A segment a plugin beneath already
// declares is the exception: a file retunes it by field, as it retunes any
// inherited segment.
export function pluginScopeCollisions(
  ctx: ValidateCtx,
  out: Mutable<RawDslConfig>,
  inherited: ReadonlySet<string>,
): void {
  for (const section of [
    "variables",
    "actions",
    "helpers",
    "segments",
  ] as const) {
    for (const name of Object.keys(out[section] ?? {})) {
      const scope = scopeOf(name);
      if (scope === undefined) continue;
      if (section !== "variables" && name === scope) continue;
      if (section === "segments" && inherited.has(name)) continue;
      ctx.issues.push({
        path: `${section}.${name}`,
        message: `"${name}" is in "${scope}", the namespace plugins own (each declares its names there from its own definition) — rename it`,
        line: findKeyLine(ctx.source, [section, name]),
      });
    }
  }
  for (const [segment, decl] of Object.entries(out.segments ?? {})) {
    for (const v of Object.keys(decl.vars ?? {})) {
      const name = `${segment}.${v}`;
      const scope = scopeOf(name);
      if (scope === undefined || inherited.has(segment)) continue;
      ctx.issues.push({
        path: `segments.${segment}.vars.${v}`,
        line: findKeyLine(ctx.source, ["segments", segment, "vars", v]),
        message: `segment "${segment}"'s var "${v}" is named "${name}", in "${scope}", the namespace plugins own — rename the var or the segment`,
      });
    }
  }
}

// A payload input (payload-inputs.ts) is the daemon's: the session a copy or
// `run` names, the file `↗ config` opens, the setting a picker marks current.
// Every config reads it from beneath the bundled default, so a file's own
// variable of that name — top-level or a segment var — would make the bar's
// own acts read another value. The declaration is dropped and the drop is a
// warning, not a refusal: configs written before the daemon owned these names
// declare them, and refusing the file would cost the user every other line of
// it for one line that is now redundant [LAW:no-silent-failure].
export function withoutPayloadDeclarations(
  filePath: string,
  source: string,
  raw: RawDslConfig,
): { raw: RawDslConfig; notices: readonly string[] } {
  const notices: string[] = [];
  const drop = (name: string, keyPath: readonly string[]): boolean => {
    if (!Object.hasOwn(PAYLOAD_INPUTS, name)) return false;
    notices.push(
      `${filePath}:${findKeyLine(source, keyPath)}: "${name}" is supplied by the daemon's payload to every config, so this declaration is ignored — remove it`,
    );
    return true;
  };
  const keep = <T>(
    record: Readonly<Record<string, T>>,
    dropped: (key: string) => boolean,
  ): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([k]) => !dropped(k)));
  return {
    raw: {
      ...raw,
      ...(raw.variables && {
        variables: keep(raw.variables, (n) => drop(n, ["variables", n])),
      }),
      ...(raw.segments && {
        segments: Object.fromEntries(
          Object.entries(raw.segments).map(([segment, decl]) => [
            segment,
            decl.vars === undefined
              ? decl
              : {
                  ...decl,
                  vars: keep(decl.vars, (v) =>
                    drop(`${segment}.${v}`, ["segments", segment, "vars", v]),
                  ),
                },
          ]),
        ),
      }),
    },
    notices,
  };
}
