// What a session key is, decided once from the key alone
// (src/config/session-key.ts). Every write's route, every undo step, every
// Back restore and every profile load asks it, so a reordering of its checks
// moves them all.

import {
  isHeldByEdit,
  isNavigationKey,
  isPlacementDraftKey,
  isSettingKey,
  isUndoStepKey,
  sessionKeyKind,
} from "../../src/config/session-key";
import { placementDraftKey } from "../../src/config/edit-chrome";
import { CONFIRM_KEY_SUFFIX } from "../../src/config/confirm-step";
import { DIAGNOSTICS_VIEWING } from "../../src/config/door";
import {
  CLICK_ERROR_KEY,
  EDIT_MODE_KEY,
} from "../../src/config/reserved-names";
import { EDIT_CONFIGURE_KEY } from "../../src/config/loader/edit-mode";
import { SETTING_PROJECTIONS } from "../../src/config/setting-projections";
import { menuPageKey, menuStateKey } from "../../src/config/menu-keys";

const PLACEMENT = { preset: "default", id: "clock", segment: "clock" };
const DRAFT = placementDraftKey(PLACEMENT, "n");
const SETTING = SETTING_PROJECTIONS[0]!.sessionKey;
const MENU = menuStateKey(PLACEMENT, "applyTheme", undefined);

describe("sessionKeyKind", () => {
  test.each([
    [EDIT_MODE_KEY, { kind: "edit", part: "mode" }],
    [DRAFT, { kind: "edit", part: "draft" }],
    [EDIT_CONFIGURE_KEY, { kind: "edit", part: "view" }],
    [SETTING, { kind: "setting" }],
    [`x${CONFIRM_KEY_SUFFIX}`, { kind: "confirm" }],
    [DIAGNOSTICS_VIEWING, { kind: "viewer" }],
    [CLICK_ERROR_KEY, { kind: "record" }],
    [MENU, { kind: "menu" }],
    [menuPageKey(MENU), { kind: "menu" }],
    ["groups.row", { kind: "menu" }],
    ["author.pick", { kind: "plain" }],
  ])("%s is %j", (key, kind) => {
    expect(sessionKeyKind(key)).toEqual(kind);
  });

  // The edit namespace is told before the rest, so an edit's own copy of a
  // setting's key or a menu's is still the edit's.
  test("edit's namespace outranks every other", () => {
    expect(sessionKeyKind(`edit.${SETTING}`).kind).toBe("edit");
    expect(sessionKeyKind(`edit.${MENU}`).kind).toBe("edit");
  });

  // A menu's key ends in its apply action's name, which an author may call
  // anything, so the menu namespaces are told before the confirm suffix.
  test("a menu whose apply action is named like a confirm's suffix is still a menu", () => {
    const armed = menuStateKey(
      PLACEMENT,
      CONFIRM_KEY_SUFFIX.slice(1),
      undefined,
    );
    expect(armed.endsWith(CONFIRM_KEY_SUFFIX)).toBe(true);
    expect(sessionKeyKind(armed).kind).toBe("menu");
    expect(isNavigationKey(armed)).toBe(true);
  });
});

describe("what each reader asks of a key", () => {
  test("an undo step holds settings and drafts, nothing else", () => {
    expect(isUndoStepKey(SETTING)).toBe(true);
    expect(isUndoStepKey(DRAFT)).toBe(true);
    for (const key of [EDIT_MODE_KEY, EDIT_CONFIGURE_KEY, MENU, "author.pick"])
      expect(isUndoStepKey(key)).toBe(false);
  });

  test("a saved history keeps settings alone", () => {
    expect(isSettingKey(SETTING)).toBe(true);
    expect(isSettingKey(DRAFT)).toBe(false);
    expect(isPlacementDraftKey(DRAFT)).toBe(true);
    expect(isPlacementDraftKey(SETTING)).toBe(false);
  });

  test("Back restores menus, an author's state and an edit's view, never a decision", () => {
    for (const key of [MENU, "author.pick", EDIT_CONFIGURE_KEY])
      expect(isNavigationKey(key)).toBe(true);
    for (const key of [
      SETTING,
      DRAFT,
      EDIT_MODE_KEY,
      `x${CONFIRM_KEY_SUFFIX}`,
      DIAGNOSTICS_VIEWING,
      CLICK_ERROR_KEY,
    ])
      expect(isNavigationKey(key)).toBe(false);
  });

  test("an edit holds every write but the bar's record of a failed click", () => {
    expect(isHeldByEdit(CLICK_ERROR_KEY)).toBe(false);
    for (const key of [SETTING, DRAFT, MENU, "author.pick"])
      expect(isHeldByEdit(key)).toBe(true);
  });
});
