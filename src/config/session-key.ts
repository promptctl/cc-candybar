// [LAW:one-source-of-truth] What a session key is, decided once from the key
// alone. Every reader and writer of session state asks this: where a write
// goes, what an undo step holds, what Back restores, what a load keeps.

import {
  EDIT_MODE_KEY,
  EDIT_NS,
  PLACEMENT_DRAFT_NS,
  reservedNamespaceOf,
} from "./reserved-names.js";
import { SETTING_PROJECTIONS } from "./setting-projections.js";
import { CONFIRM_KEY_SUFFIX } from "./confirm-step.js";
import { DIAGNOSTICS_VIEWING } from "./door.js";

// [LAW:types-are-the-program]
// - edit: edit mode's own, living only in an open edit and ending with it —
//   whether it is open (`mode`), a placement's unsaved value (`draft`), or
//   the panels, lists and pages it shows (`view`);
// - setting: what a settings control picks, which undo steps;
// - confirm: an armed two-click control, one click from firing, so nothing
//   but its own click arms it;
// - viewer: which message the diagnostics viewer shows, which is the viewer's
//   own and no menu's;
// - menu: a menu, disclosure or page cursor the bar mints;
// - plain: a key a config authors.
export type SessionKeyKind =
  | { readonly kind: "edit"; readonly part: "mode" | "draft" | "view" }
  | { readonly kind: "setting" }
  | { readonly kind: "confirm" }
  | { readonly kind: "viewer" }
  | { readonly kind: "menu" }
  | { readonly kind: "plain" };

const SETTING_KEYS: ReadonlySet<string> = new Set(
  SETTING_PROJECTIONS.map((s) => s.sessionKey),
);

export function sessionKeyKind(key: string): SessionKeyKind {
  if (key.startsWith(EDIT_NS))
    return {
      kind: "edit",
      part:
        key === EDIT_MODE_KEY
          ? "mode"
          : key.startsWith(PLACEMENT_DRAFT_NS)
            ? "draft"
            : "view",
    };
  if (SETTING_KEYS.has(key)) return { kind: "setting" };
  if (key.endsWith(CONFIRM_KEY_SUFFIX)) return { kind: "confirm" };
  if (key === DIAGNOSTICS_VIEWING) return { kind: "viewer" };
  return reservedNamespaceOf(key) === undefined
    ? { kind: "plain" }
    : { kind: "menu" };
}

export const isEditModeKey = (key: string): boolean =>
  sessionKeyKind(key).kind === "edit";

// What an undo step holds: the settings, and a placement's unsaved values,
// which are the edit's own settings. Every other key is navigation or the
// bar's own.
export function isUndoStepKey(key: string): boolean {
  const k = sessionKeyKind(key);
  return k.kind === "setting" || (k.kind === "edit" && k.part === "draft");
}

// What Back restores: the menus and an author's own state, and inside an edit
// the panels and lists it shows. Never a setting or a draft (undo's), whether
// edit mode is open (its own controls'), an armed confirm, or the viewer.
export function isNavigationKey(key: string): boolean {
  const k = sessionKeyKind(key);
  return (
    k.kind === "menu" ||
    k.kind === "plain" ||
    (k.kind === "edit" && k.part === "view")
  );
}
