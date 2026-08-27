// [LAW:behavior-not-structure] Every bar carries chrome no config declares:
// the global settings menu (candybar-settings-ui-aok.1) and the edit-mode
// affordances it makes reachable. Both are synthesized into every validated
// config, so their derived gates and their clickable regions appear in every
// render — including the small fixtures whose subject is something else
// entirely.
//
// A test about "what does MY action derive" or "what does MY template click"
// asserts a contract about its own declarations. Filtering the ambient chrome
// out keeps that assertion pointed at the contract instead of at the current
// contents of the standard library, which is exactly the difference between a
// behavior test and a structure test. A test whose subject IS the chrome reads
// the unfiltered list.
//
// [LAW:one-source-of-truth] The namespaces are IMPORTED, never re-spelled: a
// rename in the synthesis pass must break this helper loudly, not silently stop
// matching and let every filtered assertion drift.

import type { ActionDecl } from "../../src/config/action";
import type { DslConfig } from "../../src/config/dsl-types";
import { EDIT_MODE_KEY, EDIT_NS } from "../../src/config/loader/edit-mode";
import { GROUP_NS } from "../../src/config/loader/layout";
import { MENU_NS } from "../../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_NS } from "../../src/config/settings-menu";

// The reserved namespaces the synthesis passes mint under, plus the one plain
// SessionState key the settings menu's preset picker writes.
function isAmbientChromeKey(key: string): boolean {
  return (
    key === "preset" ||
    key.startsWith(SETTINGS_NS) ||
    key.startsWith(EDIT_NS) ||
    key.startsWith(`${MENU_NS}settings_`) ||
    key.startsWith(`${MENU_NS}edit_`) ||
    // Edit chrome registers a rootOps op-log key per preset the moment any
    // `+`/`-` affordance exists — which is now every config, since the settings
    // menu makes edit mode reachable from every bar.
    (key.startsWith("presets.") && key.endsWith(".rootOps"))
  );
}

// [LAW:one-source-of-truth] The SessionState keys the config's OWN actions
// write. `key === "preset"` above is a bare word — unlike the reserved
// namespaces, nothing stops a fixture from declaring an action that writes it,
// and several already do. Reading the config makes ownership a fact about this
// config rather than a guess: a key an authored action writes is the author's,
// whatever the ambient shape says, so a fixture's own contribution can never be
// swallowed into a vacuous assertion.
function authorWrittenKeys(config: DslConfig): Set<string> {
  const keys = new Set<string>();
  for (const [name, decl] of Object.entries(config.actions)) {
    if (isSynthesizedActionName(name)) continue;
    const key = writtenKey(decl);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function isSynthesizedActionName(name: string): boolean {
  return (
    name.startsWith(SETTINGS_NS) ||
    name.startsWith(EDIT_NS) ||
    name.startsWith(MENU_NS) ||
    name.startsWith(GROUP_NS)
  );
}

// [LAW:types-are-the-program] Total over the ActionDecl union: `set` (the
// SessionState key deriveActionValidators gates), `persist` and `reset` (the
// globals key deriveConfigActionValidators gates — call sites here derive both
// flavors, so reading only `set` would leave a fixture's `persist: 'preset'`
// swallowed by the very arm this function exists to narrow). `copy`/`open`/
// `undo`/`redo` name no key and so write none.
function writtenKey(decl: ActionDecl): string | undefined {
  if ("set" in decl) return decl.set;
  if ("persist" in decl) return decl.persist;
  if ("reset" in decl) return decl.reset;
  return undefined;
}

export function ownValidators<T extends { key: string }>(
  config: DslConfig,
  entries: readonly T[],
): T[] {
  const authored = authorWrittenKeys(config);
  return entries.filter(
    (e) => authored.has(e.key) || !isAmbientChromeKey(e.key),
  );
}

// The click URLs the ambient chrome emits, removed from a collected list so a
// template's own clickable regions are what the assertion counts.
export function ownLinks(urls: readonly string[]): string[] {
  return withoutSettingsLinks(urls).filter((u) => !u.includes(EDIT_MODE_KEY));
}

// The narrower filter, for a test whose OWN subject is edit mode: only the
// settings toggle is ambient there, and the menu's `✎ edit` entry is
// `when`-gated behind a closed disclosure, so it emits nothing to confuse it.
export function withoutSettingsLinks(urls: readonly string[]): string[] {
  return urls.filter((u) => !u.includes(SETTINGS_ANCHOR));
}

// Declaration NAMES the synthesis passes add to a validated config — the
// reserved namespaces plus the one ordinary variable edit chrome ensures for
// its own banner. A test asserting "what did the AUTHOR declare" filters these.
export function ownDeclNames(names: readonly string[]): string[] {
  return names.filter(
    (n) =>
      n !== "preset.customized" &&
      !n.startsWith(SETTINGS_NS) &&
      !n.startsWith(EDIT_NS) &&
      !n.startsWith(MENU_NS) &&
      !n.startsWith(GROUP_NS),
  );
}
