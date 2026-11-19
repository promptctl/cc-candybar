// [LAW:one-way-deps] A leaf with no imports, so the click codec
// (src/click/wire.ts) reads these names without loading the config loader. The
// collision checks over them are the loader's,
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

export const RESERVED_NAMESPACES = [
  GROUP_NS,
  MENU_NS,
  MENU_PAGE_NS,
  EDIT_NS,
  SETTINGS_NS,
] as const;

// The reserved namespace `name` lies in, or none for a name a user can author.
export function namespaceOf(name: string): string | undefined {
  return RESERVED_NAMESPACES.find((ns) => name.startsWith(ns));
}

// A name a user can never author: every synthesized artifact lives under one
// of the prefixes above, so membership alone proves "synthesized, not
// declared" — the fact edit chrome (structural, not removable content), the
// delta-able segment set (a delta targets an authorable name), and the test
// helpers all read from here rather than re-spelling the prefix list.
export function isReservedName(name: string): boolean {
  return namespaceOf(name) !== undefined;
}

// [LAW:single-enforcer] THE classifier of a session key as edit chrome: the
// open or closed state of edit mode's own controls (its toggles, its ✚
// libraries, its configure lists, and the page cursor of any of them). It
// reads the key alone, with no layout and no open edit, because the key is
// spelled in edit mode's namespace by whatever minted it — a menu's key in its
// host's namespace inside `menus.` — and no author identifier reaches that
// namespace (the loader refuses an authored store key there). Chrome lives
// only as long as the edit it serves, so every read and every write of the
// session store asks this one question.
export function isChromeKey(key: string): boolean {
  return [MENU_PAGE_NS, MENU_NS]
    .reduce((k, ns) => (k.startsWith(ns) ? k.slice(ns.length) : k), key)
    .startsWith(EDIT_NS);
}
