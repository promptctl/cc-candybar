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

// The reserved namespaces the synthesis passes mint under, plus the one plain
// SessionState key the settings menu's preset picker writes.
function isAmbientChromeKey(key: string): boolean {
  return (
    key === "preset" ||
    key.startsWith("settings.") ||
    key.startsWith("edit.") ||
    key.startsWith("menus.settings_") ||
    key.startsWith("menus.edit_") ||
    // Edit chrome registers a rootOps op-log key per preset the moment any
    // `+`/`-` affordance exists — which is now every config, since the settings
    // menu makes edit mode reachable from every bar.
    (key.startsWith("presets.") && key.endsWith(".rootOps"))
  );
}

export function ownValidators<T extends { key: string }>(
  entries: readonly T[],
): T[] {
  return entries.filter((e) => !isAmbientChromeKey(e.key));
}

// The click URLs the ambient chrome emits, removed from a collected list so a
// template's own clickable regions are what the assertion counts.
export function ownLinks(urls: readonly string[]): string[] {
  return withoutSettingsLinks(urls).filter((u) => !u.includes("edit.mode"));
}

// The narrower filter, for a test whose OWN subject is edit mode: only the
// settings toggle is ambient there, and the menu's `✎ edit` entry is
// `when`-gated behind a closed disclosure, so it emits nothing to confuse it.
export function withoutSettingsLinks(urls: readonly string[]): string[] {
  return urls.filter((u) => !u.includes("settings.menu"));
}

// Declaration NAMES the synthesis passes add to a validated config — the
// reserved namespaces plus the one ordinary variable edit chrome ensures for
// its own banner. A test asserting "what did the AUTHOR declare" filters these.
export function ownDeclNames(names: readonly string[]): string[] {
  return names.filter(
    (n) =>
      n !== "preset.customized" &&
      !n.startsWith("settings.") &&
      !n.startsWith("edit.") &&
      !n.startsWith("menus.") &&
      !n.startsWith("groups."),
  );
}
