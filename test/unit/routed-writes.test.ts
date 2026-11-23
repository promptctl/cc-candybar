// THE decision of where a session write goes (src/renderer/edit-transaction.ts):
// into the session's open edit, whole, but for the bar's own record of a
// failed click; with none open, edit mode's keys aside and the rest to the
// store. Reads come back from where the writes went.

import { heldAside, routedWrites } from "../../src/renderer/edit-transaction";
import type { DraftWrites } from "../../src/renderer/edit-transaction";
import { SessionState } from "../../src/renderer/session-state";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { placementDraftKey } from "../../src/config/edit-chrome";
import {
  CLICK_ERROR_KEY,
  EDIT_MODE_KEY,
} from "../../src/config/reserved-names";
import { EDIT_MODE_ARRANGE } from "../../src/config/loader/edit-mode";
import { SETTING_PROJECTIONS } from "../../src/config/setting-projections";

const S1 = sessionIdOf("s1");
const SETTING = SETTING_PROJECTIONS[0]!.sessionKey;
const DRAFT = placementDraftKey(
  { preset: "default", id: "clock", segment: "clock" },
  "n",
);

function draftOver(store: SessionState): {
  draft: DraftWrites;
  held: Map<string, string | null>;
} {
  const held = new Map<string, string | null>();
  return {
    held,
    draft: {
      read: (key) => (held.has(key) ? held.get(key)! : store.get(S1, key)),
      put: (key, value) => held.set(key, value),
    },
  };
}

describe("with an edit open", () => {
  test("every write goes into the edit, and the store is untouched", () => {
    const store = new SessionState();
    const { draft, held } = draftOver(store);
    const routed = routedWrites(store, () => draft, heldAside());
    routed.setBatch(S1, [
      { key: SETTING, value: "x" },
      { key: DRAFT, value: "7" },
      { key: EDIT_MODE_KEY, value: EDIT_MODE_ARRANGE },
      { key: "author.pick", value: "y" },
    ]);
    expect([...held.keys()]).toEqual([
      SETTING,
      DRAFT,
      EDIT_MODE_KEY,
      "author.pick",
    ]);
    expect(store.get(S1, SETTING)).toBeNull();
    expect(routed.get(S1, DRAFT)).toBe("7");
  });

  test("the bar's record of a failed click is the store's, so cancelling the edit does not erase it", () => {
    const store = new SessionState();
    const { draft, held } = draftOver(store);
    const routed = routedWrites(store, () => draft, heldAside());
    routed.set(S1, CLICK_ERROR_KEY, "{}");
    expect(held.size).toBe(0);
    expect(store.get(S1, CLICK_ERROR_KEY)).toBe("{}");
    expect(routed.get(S1, CLICK_ERROR_KEY)).toBe("{}");
  });
});

describe("with none open", () => {
  test("edit mode's keys are held aside and read back from there, and the rest reach the store", () => {
    const store = new SessionState();
    const aside = heldAside();
    const routed = routedWrites(store, () => null, aside);
    routed.setBatch(S1, [
      { key: EDIT_MODE_KEY, value: EDIT_MODE_ARRANGE },
      { key: DRAFT, value: "7" },
      { key: SETTING, value: "x" },
    ]);
    expect(store.get(S1, SETTING)).toBe("x");
    expect(store.get(S1, EDIT_MODE_KEY)).toBeNull();
    expect(store.get(S1, DRAFT)).toBeNull();
    expect(routed.get(S1, EDIT_MODE_KEY)).toBe(EDIT_MODE_ARRANGE);
    expect([...aside.held(S1).keys()]).toEqual([EDIT_MODE_KEY, DRAFT]);
  });

  test("a clear reaches the store", () => {
    const store = new SessionState();
    store.set(S1, SETTING, "x");
    routedWrites(store, () => null, heldAside()).clear(S1, SETTING);
    expect(store.get(S1, SETTING)).toBeNull();
  });
});
