// [LAW:behavior-not-structure] Every bar carries chrome no config declares, so a test
// about its OWN declarations filters it out; a test whose subject IS the chrome does not.

import { actionDestinations, type ActionDecl } from "../../src/config/action";
import type { DslConfig } from "../../src/config/dsl-types";
import { EDIT_NS } from "../../src/config/loader/edit-mode";
import { GROUP_NS } from "../../src/config/loader/layout";
import { MENU_NS } from "../../src/config/menu-keys";
import { parsePersistTarget } from "../../src/config/loader/persist-target";
import { PRESET_CUSTOMIZED_VAR } from "../../src/config/edit-chrome";
import {
  SETTINGS_NS,
  SETTINGS_WRITTEN_KEYS,
} from "../../src/config/settings-menu";
import {
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
} from "../../src/click/wire";
import { effectsOf } from "./click";

// [LAW:one-source-of-truth] Keys only the SYNTHESIS can produce. Every arm is under a
// reserved namespace, so membership alone proves the key is chrome.
function isReservedChromeKey(key: string): boolean {
  return (
    key.startsWith(SETTINGS_NS) ||
    key.startsWith(EDIT_NS) ||
    // The settings menu's own pickers, hosted on `settings.<setting>`.
    key.startsWith(`${MENU_NS}settings_`) ||
    key.startsWith(`${MENU_NS}edit_`) ||
    // [LAW:parse-dont-validate] Asked of the canonical parser rather than matched as
    // `presets.` + `.root`: its greedy capture round-trips a dotted preset name.
    parsePersistTarget(key)?.scope === "preset-root"
  );
}

// Plus bare keys the menu's controls write, which an author CAN own — pair with authorship.
function isAmbientChromeKey(key: string): boolean {
  return SETTINGS_WRITTEN_KEYS.has(key) || isReservedChromeKey(key);
}

// [LAW:one-source-of-truth] Ownership read from the config, so a fixture's own key survives.
function authorWrittenKeys(config: DslConfig): Set<string> {
  const keys = new Set<string>();
  for (const [name, decl] of Object.entries(config.actions)) {
    if (isSynthesizedActionName(name)) continue;
    // [LAW:one-source-of-truth] The SAME explosion the derivations use; a dual has two halves.
    for (const dest of actionDestinations(decl)) {
      const key = writtenKey(dest);
      if (key !== undefined) keys.add(key);
    }
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

// [LAW:types-are-the-program] Total over ActionDecl; call sites derive both validator flavors.
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

// [LAW:one-source-of-truth] Decoded the way the daemon decodes, never sniffed as substrings.
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

// The menu's own surfaces: its `☰` toggle and its hosted picker, which shares no spelling.
function isSettingsMenuKey(key: string): boolean {
  return key.startsWith(SETTINGS_NS) || key.startsWith(`${MENU_NS}settings_`);
}

// [LAW:no-silent-failure] Deliberately does NOT filter the bare `preset` key: an author
// can own it and this signature has no config to check, so under-filtering is the loud way.
export function ownLinks(urls: readonly string[]): string[] {
  // [LAW:one-source-of-truth] The same reserved-key predicate the validator filter reads.
  return withoutSettingsLinks(urls).filter(
    (u) => !keysWrittenBy(u).some(isReservedChromeKey),
  );
}

// The narrower filter, for a test whose OWN subject is edit mode.
export function withoutSettingsLinks(urls: readonly string[]): string[] {
  return urls.filter((u) => !keysWrittenBy(u).some(isSettingsMenuKey));
}

// Declaration NAMES the synthesis adds. `PRESET_CUSTOMIZED_VAR` gets no authorship check because a name carries no author.
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
