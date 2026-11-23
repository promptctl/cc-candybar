// [LAW:one-way-deps] A leaf with no imports: every layer reads these names and
// nothing here reaches up. The collision checks over them are the loader's,
// src/config/loader/reserved-namespace.ts.

// [LAW:one-source-of-truth] The reserved namespaces, spelled once. Each is the
// prefix one synthesis pass mints its artifacts under — the `state` var, the
// `cycle` action, the toggle segment — and reserves against user authorship:
// group sugar (layout.ts), the `{{ menu }}` helper (menu-keys.ts), edit mode
// (edit-mode.ts, plus edit-chrome.ts's per-placement controls), and the global
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

// [LAW:one-source-of-truth] The bar's record of a click that failed
// (src/daemon/foundations/click-error.ts): about the click, not state any edit
// shapes, so no edit holds it.
export const CLICK_ERROR_KEY = `${SETTINGS_NS}clickError`;

// Whether edit mode is open, and the namespace every placement's unsaved
// setting value lives under (edit-mode.ts). No scalar is declared at
// `edit.draft`, so nothing under it can be shadowed by one.
export const EDIT_MODE_KEY = `${EDIT_NS}mode`;
export const PLACEMENT_DRAFT_NS = `${EDIT_NS}draft.`;

export const RESERVED_NAMESPACES = [
  GROUP_NS,
  MENU_NS,
  MENU_PAGE_NS,
  EDIT_NS,
  SETTINGS_NS,
] as const;

// The namespace a name sits in, spelled as written: every artifact a
// synthesis pass names lives under one of the prefixes above, so membership
// proves a segment, variable or action "synthesized, not declared" — the fact
// edit chrome (structural, not removable content), the delta-able segment set
// (a delta targets an authorable name) and the test helpers read from here
// rather than re-spelling the prefix list. What a session key is, the session
// state's readers ask of session-key.ts.
export function reservedNamespaceOf(name: string): string | undefined {
  return RESERVED_NAMESPACES.find((ns) => name.startsWith(ns));
}

// [LAW:one-source-of-truth] Whether a key sits in the namespaces the menu pass
// mints under: a menu's state and its page cursor.
export function isMenuStateKey(key: string): boolean {
  return key.startsWith(MENU_NS) || key.startsWith(MENU_PAGE_NS);
}

export function isReservedName(name: string): boolean {
  return reservedNamespaceOf(name) !== undefined;
}
