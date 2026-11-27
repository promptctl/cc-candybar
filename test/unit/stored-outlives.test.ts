import { durableHistory } from "../../src/renderer-interface/history-storage";
// What a live renderer shares with its host, and what the profile keeps.

import { SESSION_STATE_FILE } from "../../src/daemon/session-state-file";
import { storedPicksAfter } from "../../src/renderer-interface/stored-state";
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
        { part: EDIT_MODE_KEY, why: "edit-mode picks belong to the live draft" },
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
    reason: `holds only picks this build reads nothing of: ${EDIT_CONFIGURE_KEY} (edit-mode picks belong to the live draft)`,
  });
});

test("live changes include private edit picks and the durable projection omits them", () => {
  const state = new SessionState();
  state.set(S1, "theme", "nord");
  state.set(S1, EDIT_MODE_KEY, "closed");
  state.set(S2, EDIT_CONFIGURE_KEY, "default:clock");
  const writes = state.drain();
  expect(writes).toEqual([
    {
      kind: "patch",
      store: "session-state",
      key: S1,
      changes: { theme: "nord", [EDIT_MODE_KEY]: "closed" },
    },
    {
      kind: "patch",
      store: "session-state",
      key: S2,
      changes: { [EDIT_CONFIGURE_KEY]: "default:clock" },
    },
  ]);
  expect(
    writes.map((write) => {
      if (write.kind !== "patch") throw new Error("expected live picks");
      return storedPicksAfter(undefined, write);
    }),
  ).toEqual([{ theme: "nord" }, null]);
});

test.each([1, 128])(
  "a changed pick among %d other picks has the same payload",
  (count) => {
    const others = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [String(i), "old"]),
    );
    const state = new SessionState({
      [S1]: { ...others, changed: "old" },
      [S2]: { other: "untouched" },
    });
    state.set(S1, "changed", "new");
    state.heard(S2);
    expect(state.drain()).toEqual([
      {
        kind: "patch",
        store: "session-state",
        key: S1,
        changes: { changed: "new" },
      },
      { kind: "heard", store: "session-state", key: S2 },
    ]);
    state.clear(S1, "changed");
    expect(state.drain()).toEqual([
      {
        kind: "patch",
        store: "session-state",
        key: S1,
        changes: { changed: null },
      },
    ]);
  },
);

test("eviction and recreation in one turn erase the old keys on a warm host", () => {
  const old = { first: "one", second: "two" };
  const state = new SessionState({ [S1]: old }, 1);
  state.set(S2, "other", "value");
  state.set(S1, "first", "back");
  const writes = state.drain();
  expect(writes).toEqual([
    {
      kind: "patch",
      store: "session-state",
      key: S1,
      changes: { first: "back", second: null },
    },
    { kind: "drop", store: "session-state", key: S2 },
  ]);
  const [revived] = writes;
  if (revived?.kind !== "patch") throw new Error("expected revived picks");
  expect(storedPicksAfter(old, revived)).toEqual({ first: "back" });
  state.clear(S1, "first");
  expect(state.drain()).toEqual([
    { kind: "drop", store: "session-state", key: S1 },
  ]);
});

test("history changes carry private draft steps while legacy files keep only setting changes", () => {
  const history = new SettingsHistory(new SessionState(), () => {});
  const draft = `${PLACEMENT_DRAFT_NS}default.clock.format`;
  const both = history.begin(NO_LAYERS);
  both.sessionState.set(S1, "theme", "nord");
  both.sessionState.set(S1, draft, "24h");
  both.commit();
  const only = history.begin(NO_LAYERS);
  only.sessionState.set(S2, draft, "12h");
  only.commit();
  const writes = history.drain();
  const theme = { kind: "session", key: "theme", before: null, after: "nord" };
  expect(writes).toEqual([
    { kind: "steps", store: "settings-history", key: S1, edits: [{kind: "append", step: [
      theme, {kind: "session", key: draft, before: null, after: "24h"},
    ]}] },
    { kind: "steps", store: "settings-history", key: S2, edits: [{kind: "append", step: [
      {kind: "session", key: draft, before: null, after: "12h"},
    ]}] },
  ]);
  expect(durableHistory(history.history(S1))).toEqual({past:[[theme]], future: []});
  expect(durableHistory(history.history(S2))).toBeNull();
});
