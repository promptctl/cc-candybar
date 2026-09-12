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

// [LAW:one-source-of-truth] The reserved namespaces, spelled once. Each is the
// prefix one synthesis pass mints its artifacts under — the `state` var, the
// `cycle` action, the toggle segment — and reserves against user authorship:
// group sugar (layout.ts), the `{{ menu }}` helper (menu-keys.ts), edit mode
// (edit-mode.ts, plus edit-chrome.ts's per-position controls), and the global
// settings menu (settings-menu.ts). They live here, downhill of every
// synthesizer, so the one predicate over them (`isReservedName`) never has to
// reach up into a pass that already imports this module [LAW:one-way-deps].
export const GROUP_NS = "groups.";
export const MENU_NS = "menus.";
export const EDIT_NS = "edit.";
export const SETTINGS_NS = "settings.";

const RESERVED_NAMESPACES = [GROUP_NS, MENU_NS, EDIT_NS, SETTINGS_NS] as const;

// A name a user can never author: every synthesized artifact lives under one
// of the prefixes above, so membership alone proves "synthesized, not
// declared" — the fact edit chrome (structural, not removable content), the
// delta-able segment set (a delta targets an authorable name), and the test
// helpers all read from here rather than re-spelling the prefix list.
export function isReservedName(name: string): boolean {
  return RESERVED_NAMESPACES.some((ns) => name.startsWith(ns));
}

// [LAW:one-source-of-truth] The same reservation, asked in `ident()` SPACE — the
// question an authored name that never becomes a declaration has to answer. A
// `{{ menu }}` accordion key is such a name: it is a template argument, so
// `reservedNamespaceCollisions` below (which walks declaration sections) cannot
// see it, and `menuStateKey` collapses it through `ident()` before it becomes the
// state key. That collapse is where the reservation leaked: `settings.pickers`,
// `settings-pickers` and `settings_pickers` all collapse to `settings_pickers`,
// so all three derived the state key the settings menu's own picker accordion
// mints and JOINED it — opening a user menu closed the settings picker, with no
// error naming the cause (brandon-menus-du8).
//
// Comparing in ident() space is what closes the CLASS rather than a spelling
// [LAW:behavior-not-structure]: `ident()`'s codomain is `[A-Za-z0-9_]*`, so an
// authored name can only collide with a synthesized `ns + x` when its own
// collapse starts with `ident(ns)`. Testing the authored spelling for a leading
// `"settings."` — the check the reviewer proposed — misses two of those three.
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
