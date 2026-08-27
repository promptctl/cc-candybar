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
import { EDIT_NS } from "../../src/config/loader/edit-mode";
import { GROUP_NS } from "../../src/config/loader/layout";
import { MENU_NS } from "../../src/config/menu-keys";
import { parsePersistTarget } from "../../src/config/loader/persist-target";
import { PRESET_CUSTOMIZED_VAR } from "../../src/config/edit-chrome";
import { SETTINGS_NS } from "../../src/config/settings-menu";
import {
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
} from "../../src/click/wire";
import { effectsOf } from "./click";

// [LAW:one-source-of-truth] Keys only the SYNTHESIS can produce, spelled once
// for both consumers below. Every arm is under a namespace the loader reserves,
// so no author declaration can land here and no authorship check is needed:
// membership alone proves the key is chrome.
function isReservedChromeKey(key: string): boolean {
  return (
    key.startsWith(SETTINGS_NS) ||
    key.startsWith(EDIT_NS) ||
    // The settings menu's own preset picker, hosted on `settings.presets`.
    key.startsWith(`${MENU_NS}settings_`) ||
    // NOT vestigial: edit chrome's `+` affordance hosts a menu on each
    // `edit.<preset>.insertSeg.<n>` segment (edit-chrome.ts's insertChrome
    // calls menuStateKey directly), and `ident()` collapses the dots — so a
    // bundled-default config really does derive 30+ keys under this prefix.
    key.startsWith(`${MENU_NS}edit_`) ||
    // Edit chrome registers a rootOps op-log key per preset the moment any
    // `+`/`-` affordance exists — which is now every config, since the settings
    // menu makes edit mode reachable from every bar.
    //
    // [LAW:parse-dont-validate] Asked of the canonical parser rather than
    // matched as `presets.` + `.rootOps`. persist-target.ts owns that format
    // (its own comment records two write-side spellings drifting before they
    // were consolidated), and its regex captures greedily so a dotted preset
    // name like "v1.compact" round-trips — a hand-rolled prefix/suffix pair
    // gets that silently wrong.
    parsePersistTarget(key)?.scope === "preset-root-ops"
  );
}

// The reserved keys, plus the one plain SessionState key the settings menu's
// preset picker writes. `preset` is a bare word an author CAN own, which is why
// every consumer of this predicate must pair it with an authorship check.
function isAmbientChromeKey(key: string): boolean {
  return key === "preset" || isReservedChromeKey(key);
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

// [LAW:one-source-of-truth] The keys a click URL writes, decoded the way the
// daemon decodes them (`effectsOf`) rather than sniffed as substrings of the
// wire encoding. Every key-writing verb takes `[sessionId, key, …]`; the rest
// (apply-layout-op, undo/redo, copy, open) write no key and so contribute none
// — which is what keeps a layout-edit affordance out of these filters, since
// its op-log write is a preset's business, not the settings menu's.
const KEY_WRITING_VERBS = new Set<string>([
  VERB_SET_STATE,
  VERB_STEP_STATE,
  VERB_SET_CONFIG,
  VERB_STEP_CONFIG,
  VERB_RESET_CONFIG,
]);

function keysWrittenBy(url: string): string[] {
  return effectsOf(url)
    .filter((e) => KEY_WRITING_VERBS.has(e.verb))
    .map((e) => e.args[1])
    .filter((k): k is string => k !== undefined);
}

// The settings menu's OWN surfaces: its `☰` toggle and — the part a substring
// match on the anchor missed — its hosted preset picker, whose disclosure key
// is `menus.settings_presets.…` and shares none of the anchor's spelling. A
// test that opens the menu before collecting links would otherwise have counted
// the picker's toggle as one of its fixture's own regions.
function isSettingsMenuKey(key: string): boolean {
  return key.startsWith(SETTINGS_NS) || key.startsWith(`${MENU_NS}settings_`);
}

// The click URLs the ambient chrome emits, removed from a collected list so a
// template's own clickable regions are what the assertion counts.
//
// [LAW:no-silent-failure] Deliberately does NOT filter the bare `preset` key
// the menu's picker applies. Unlike every key above, `preset` is a name an
// author can own — test/dsl-persist-actions.ts declares `{ persist: 'preset' }`
// and calls this function — and unlike `ownValidators`, this signature has no
// config to check authorship against. Under-filtering surfaces as an unexpected
// extra link in an assertion; over-filtering silently swallows the fixture's
// own link and makes the assertion vacuous. The loud direction wins.
export function ownLinks(urls: readonly string[]): string[] {
  // [LAW:one-source-of-truth] Reads the same reserved-key predicate the
  // validator filter does, rather than restating a prefix list that drifted
  // once already: matching `edit.` alone missed edit chrome's own insert-menu
  // disclosure, whose key is `menus.edit_<preset>_insertSeg_<n>.…`.
  //
  // Safe for a layout-edit test's own subject because `apply-layout-op` is not
  // a key-writing verb — `keysWrittenBy` reports nothing for it, so a `+`/`-`
  // click is never a filter candidate whatever this predicate says.
  return withoutSettingsLinks(urls).filter(
    (u) => !keysWrittenBy(u).some(isReservedChromeKey),
  );
}

// The narrower filter, for a test whose OWN subject is edit mode: only the
// settings menu is ambient there, and its `✎ edit` entry is `when`-gated behind
// a closed disclosure, so it emits nothing to confuse it.
export function withoutSettingsLinks(urls: readonly string[]): string[] {
  return urls.filter((u) => !keysWrittenBy(u).some(isSettingsMenuKey));
}

// Declaration NAMES the synthesis passes add to a validated config — the
// reserved namespaces plus the one ordinary variable edit chrome ensures for
// its own banner. A test asserting "what did the AUTHOR declare" filters these.
//
// `PRESET_CUSTOMIZED_VAR` gets no authorship check, unlike `ownValidators`'
// bare `preset`, because there is no discriminator to read: a WRITE carries its
// author in the action's name, but a DECLARATION name carries nothing, and by
// the time these names are collected the merged config holds one entry whether
// edit chrome ensured it or an author declared it. Closing that collision would
// mean reserving or namespacing the name upstream, not filtering harder here.
export function ownDeclNames(names: readonly string[]): string[] {
  return names.filter(
    (n) =>
      n !== PRESET_CUSTOMIZED_VAR &&
      !n.startsWith(SETTINGS_NS) &&
      !n.startsWith(EDIT_NS) &&
      !n.startsWith(MENU_NS) &&
      !n.startsWith(GROUP_NS),
  );
}
