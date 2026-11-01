// [LAW:one-way-deps] A leaf with no imports, so the click codec
// (src/click/wire.ts) reads these names without loading the config loader. The
// collision checks over them are the loader's,
// src/config/loader/reserved-namespace.ts.

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
// A menu's page cursor (menu-keys.ts), reserved by the menu pass beside
// `menus.` so no authored name is overwritten by one.
export const MENU_PAGE_NS = "menupages.";
export const EDIT_NS = "edit.";
// `candybar.`, not `settings.`: `.settings` in a segment's templates is its
// placement's own settings (brandon-segment-settings-i4n), so no variable may
// live under that name.
export const SETTINGS_NS = "candybar.";

export const RESERVED_NAMESPACES = [
  GROUP_NS,
  MENU_NS,
  MENU_PAGE_NS,
  EDIT_NS,
  SETTINGS_NS,
] as const;

// A name a user can never author: every synthesized artifact lives under one
// of the prefixes above, so membership alone proves "synthesized, not
// declared" — the fact edit chrome (structural, not removable content), the
// delta-able segment set (a delta targets an authorable name), and the test
// helpers all read from here rather than re-spelling the prefix list.
export function isReservedName(name: string): boolean {
  return RESERVED_NAMESPACES.some((ns) => name.startsWith(ns));
}
