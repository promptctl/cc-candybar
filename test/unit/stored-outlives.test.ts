// What of a renderer's stores outlives it: what its file keeps across a
// restart, and what a renderer hands the host, are one rule. So a file never
// holds what only one renderer reads, and a load that drops a key is reading
// what an older build wrote.

import { SESSION_STATE_FILE } from "../../src/daemon/session-state-file";
import { SessionState } from "../../src/renderer/session-state";
import { SettingsHistory } from "../../src/renderer/settings-history";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import {
  CLICK_ERROR_KEY,
  EDIT_MODE_KEY,
  PLACEMENT_DRAFT_NS,
} from "../../src/config/reserved-names";
import {
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
} from "../../src/config/loader/edit-mode";
import { menuKeyOf } from "../helpers/menu-key";
import { NO_LAYERS } from "../helpers/history-step";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");

test("a session's picks load without each key this build reads nothing of, and name why", () => {
  const live = menuKeyOf("picker", "applyTheme");
  const parsed = SESSION_STATE_FILE.parse({
    [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE,
    // Menu spellings no current derivation makes: a menu keyed by its
    // segment alone, and edit chrome's collapsed menu.
    "menus.picker.applyTheme": "applyTheme",
    "menus.edit_default_insertSeg": "x",
    // A record of a failed click no build wrote.
    [CLICK_ERROR_KEY]: "x",
    [live]: "applyTheme",
    theme: "nord",
  });
  expect(parsed).toEqual({
    kind: "ok",
    value: {
      value: { [live]: "applyTheme", theme: "nord" },
      dropped: [
        { part: EDIT_MODE_KEY, why: "no edit outlives the renderer" },
        {
          part: "menus.picker.applyTheme",
          why: "no menu is keyed that way in this build",
        },
        {
          part: "menus.edit_default_insertSeg",
          why: "no menu is keyed that way in this build",
        },
        {
          part: CLICK_ERROR_KEY,
          why: "not a record of a failed click this build reads",
        },
      ],
    },
  });
});

test("a session holding only what this build reads nothing of takes no slot", () => {
  expect(
    SESSION_STATE_FILE.parse({ [EDIT_CONFIGURE_KEY]: "default:clock" }),
  ).toEqual({
    kind: "failed",
    reason: `holds only picks this build reads nothing of: ${EDIT_CONFIGURE_KEY} (no edit outlives the renderer)`,
  });
});

// [LAW:single-enforcer] The renderer hands the host what a load would keep,
// so an edit opened and closed leaves no key for the next load to drop.
test("a session's picks reach the host without edit mode's own, and one holding only those is gone", () => {
  const state = new SessionState();
  state.set(S1, "theme", "nord");
  state.set(S1, EDIT_MODE_KEY, "closed");
  state.set(S2, EDIT_CONFIGURE_KEY, "default:clock");
  expect(state.drain()).toEqual([
    { kind: "put", store: "session-state", key: S1, value: { theme: "nord" } },
    { kind: "put", store: "session-state", key: S2, value: null },
  ]);
});

test("a history reaches the host without a placement draft's steps", () => {
  const history = new SettingsHistory(new SessionState(), () => {});
  const draft = `${PLACEMENT_DRAFT_NS}default.clock.format`;
  const both = history.begin(NO_LAYERS);
  both.sessionState.set(S1, "theme", "nord");
  both.sessionState.set(S1, draft, "24h");
  both.commit();
  const only = history.begin(NO_LAYERS);
  only.sessionState.set(S2, draft, "12h");
  only.commit();
  expect(history.drain()).toEqual([
    {
      kind: "put",
      store: "settings-history",
      key: S1,
      value: {
        past: [
          [{ kind: "session", key: "theme", before: null, after: "nord" }],
        ],
        future: [],
      },
    },
    { kind: "put", store: "settings-history", key: S2, value: null },
  ]);
});
