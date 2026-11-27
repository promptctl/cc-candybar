// The host's held stores: a write a file refuses is told by its storage, and
// the write is still held.

import { HeldStores, type ProfileStorage } from "../../src/daemon/held-stores";
import { commandTray } from "../../src/config/command-tray";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../../src/config/door";
import { EDIT_MODE_KEY } from "../../src/config/reserved-names";
import { EDIT_MODE_ARRANGE } from "../../src/config/loader/edit-mode";
import { SessionState } from "../../src/renderer/session-state";
import { ephemeralSessionFile } from "../../src/daemon/session-state-file";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { heldClock } from "../helpers/held-clock";
import { heldStorage } from "../helpers/held-storage";
import type { StoreStanding } from "../../src/daemon/foundations/stored-file";
import type { SessionHistory } from "../../src/renderer-interface/history-storage";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");
const STEP = { past: [], future: [] };

function held(
  storage: Partial<ProfileStorage>,
  told: (standing: StoreStanding) => void = () => {},
): HeldStores {
  const stores = new HeldStores(
    {
      session: ephemeralSessionFile(),
      history: ephemeralSessionFile(),
      ...storage,
    },
    heldClock(new Date(1_000_000)),
    told,
  );
  stores.load();
  return stores;
}

test("a replacement restores a committed menu and confirmation without restoring edit-mode keys", () => {
  const stores = held({});
  const first = new SessionState(stores.current().sessions);
  first.set(S1, SETTINGS_ANCHOR, SETTINGS_OPEN);
  const arm = commandTray("commands.").actions["commands.clear.arm"]!;
  if (!("set" in arm && "to" in arm)) throw new Error("Expected a set action");
  first.set(S1, arm.set, arm.to);
  first.set(S1, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
  stores.take(first.drain());

  const replacement = new SessionState(stores.current().sessions);
  expect(replacement.get(S1, SETTINGS_ANCHOR)).toBe(SETTINGS_OPEN);
  expect(replacement.get(S1, arm.set)).toBe(arm.to);
  expect(replacement.get(S1, EDIT_MODE_KEY)).toBeNull();
});

// [LAW:no-silent-failure] A file that refuses a write is told by its storage,
// not thrown into the turn that made it, and what the turn changed is held.
test("a history its file refuses is told, and the step is still held", () => {
  const told: StoreStanding[] = [];
  const history = heldStorage<SessionHistory>(undefined, {
    file: "/state/history.json",
    save: () => history.land({ ok: false, error: new Error("ENOSPC") }),
  });
  const stores = held({ history: history.storage }, (standing) =>
    told.push(standing),
  );
  stores.take([
    { kind: "put", store: "settings-history", key: S1, value: STEP },
    { kind: "put", store: "session-state", key: S1, value: { pick: "a" } },
  ]);
  expect(told).toEqual([
    {
      store: "Settings history",
      file: "/state/history.json",
      behind: "ENOSPC",
    },
  ]);
  expect(stores.current().history[S1]).toEqual(STEP);
  expect(stores.current().sessions[S1]).toEqual({ pick: "a" });
});

// [LAW:no-silent-failure] A shutdown that lost state says so.
test("a close whose flush the file refuses rejects with the file's error", async () => {
  const refused = Object.assign(new Error("ENOSPC: no space"), {
    code: "ENOSPC",
  });
  const stores = held({
    session: heldStorage<Record<string, string>>(undefined, {
      flush: () => Promise.reject(refused),
    }).storage,
  });
  await expect(stores.close()).rejects.toBe(refused);
});

test("writes taken after the close are held, and none is written", async () => {
  const history = heldStorage<SessionHistory>();
  const stores = held({ history: history.storage });
  await stores.close();
  stores.take([
    { kind: "put", store: "settings-history", key: S1, value: STEP },
  ]);
  expect(history.saves).toHaveLength(0);
  expect(stores.current().history[S1]).toEqual(STEP);
});

test("each store hears only its own writes, in the order the turn made them", () => {
  const session = heldStorage<Record<string, string>>({
    kind: "ok",
    sessions: new Map([
      [S1, { pick: "a" }],
      [S2, { pick: "b" }],
    ]),
  });
  const history = heldStorage<SessionHistory>();
  const stores = held({ session: session.storage, history: history.storage });
  stores.take([
    { kind: "heard", store: "session-state", key: S1 },
    { kind: "put", store: "settings-history", key: S2, value: STEP },
    { kind: "put", store: "session-state", key: S2, value: { pick: "c" } },
  ]);
  expect([...session.saves.at(-1)!]).toEqual([
    [S1, { pick: "a" }],
    [S2, { pick: "c" }],
  ]);
  expect([...history.saves.at(-1)!]).toEqual([[S2, STEP]]);
});

test("a boot read before the load is refused", () => {
  const stores = new HeldStores(
    { session: ephemeralSessionFile(), history: ephemeralSessionFile() },
    heldClock(new Date(1_000_000)),
    () => {},
  );
  expect(() => stores.current()).toThrow(
    "Session picks is read before its load",
  );
});
