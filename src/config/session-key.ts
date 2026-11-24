// [LAW:one-source-of-truth] What a session key is, decided once from the key
// alone. Every reader and writer of session state asks this: where a write
// goes, what an undo step holds, what Back restores, what a load keeps.

import {
  CLICK_ERROR_KEY,
  EDIT_MODE_KEY,
  PLACEMENT_DRAFT_NS,
  isEditNamespaced,
  isMenuStateKey,
  reservedNamespaceOf,
} from "./reserved-names.js";
import { SESSION_KEY_TO_SETTING } from "./setting-projections.js";
import { CONFIRM_KEY_SUFFIX } from "./confirm-step.js";
import { DIAGNOSTICS_VIEWING } from "./door.js";
import { CLICK_MODE_KEY, HOVER_KEY } from "./click-mode.js";

// [LAW:types-are-the-program]
// - edit: edit mode's own, living only in an open edit and ending with it —
//   whether it is open (`mode`), a placement's unsaved value (`draft`), or
//   the panels, lists and pages it shows (`view`);
// - setting: what a settings control picks, which undo steps;
// - confirm: an armed two-click control, one click from firing, so nothing
//   but its own click arms it;
// - viewer: which message the diagnostics viewer shows, which is the viewer's
//   own and no menu's;
// - record: the bar's own account of a click that failed, which no edit
//   shapes, so none holds it and Back never restores it;
// - pointer: what a click means on a surface that cannot deliver more than
//   the plain one (src/config/click-mode.ts): the user's own, so no edit
//   holds it, Back never restores it and undo never steps it;
// - menu: a menu, disclosure or page cursor the bar mints;
// - plain: a key a config authors.
export type SessionKeyKind =
  | { readonly kind: "edit"; readonly part: "mode" | "draft" | "view" }
  | { readonly kind: "setting" }
  | { readonly kind: "confirm" }
  | { readonly kind: "viewer" }
  | { readonly kind: "record" }
  | { readonly kind: "pointer" }
  | { readonly kind: "menu" }
  | { readonly kind: "plain" };

export function sessionKeyKind(key: string): SessionKeyKind {
  if (isEditNamespaced(key))
    return {
      kind: "edit",
      part:
        key === EDIT_MODE_KEY
          ? "mode"
          : key.startsWith(PLACEMENT_DRAFT_NS)
            ? "draft"
            : "view",
    };
  if (SESSION_KEY_TO_SETTING.has(key)) return { kind: "setting" };
  // A menu's key ends in its apply action's name, which may be `armed`, so the
  // menu namespaces are told before the confirm suffix is.
  if (isMenuStateKey(key)) return { kind: "menu" };
  if (key.endsWith(CONFIRM_KEY_SUFFIX)) return { kind: "confirm" };
  if (key === DIAGNOSTICS_VIEWING) return { kind: "viewer" };
  if (key === CLICK_ERROR_KEY) return { kind: "record" };
  if (key === CLICK_MODE_KEY || key === HOVER_KEY) return { kind: "pointer" };
  // The rest of the bar's namespaces hold disclosures only: a group's open
  // member (`groups.`) and the settings menu's own disclosures and tabs
  // (`candybar.`). Every other bar-owned key above has its own kind.
  return reservedNamespaceOf(key) === undefined
    ? { kind: "plain" }
    : { kind: "menu" };
}

export const isEditModeKey = (key: string): boolean =>
  sessionKeyKind(key).kind === "edit";

export const isSettingKey = (key: string): boolean =>
  sessionKeyKind(key).kind === "setting";

// A placement's unsaved value of one of its settings.
export const isPlacementDraftKey = (key: string): boolean => {
  const k = sessionKeyKind(key);
  return k.kind === "edit" && k.part === "draft";
};

// Whether an open edit holds a write to the key: every key but the bar's own
// record of a failed click, which says what happened to a click and belongs to
// no edit. Cancel would erase it before it was read, and no answer could mark
// it, since an answer marks the stored record.
export const isHeldByEdit = (key: string): boolean => {
  const { kind } = sessionKeyKind(key);
  return kind !== "record" && kind !== "pointer";
};

// What an undo step holds: the settings, and a placement's unsaved values,
// which are the edit's own settings. Every other key is navigation or the
// bar's own.
export function isUndoStepKey(key: string): boolean {
  return isSettingKey(key) || isPlacementDraftKey(key);
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
