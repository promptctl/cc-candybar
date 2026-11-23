// The host's held stores: a write a file refuses is the turn's taking's
// failure, which the host says on every bar, and the write is still held.

import {
  EPHEMERAL_HISTORY_STORAGE,
  HeldStores,
  type ProfileStorage,
} from "../../src/daemon/held-stores";
import { ephemeralSessionFile } from "../../src/daemon/session-state-file";
import {
  CLICK_ERROR_KEY,
  EDIT_MODE_KEY,
} from "../../src/config/reserved-names";
import {
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
} from "../../src/config/loader/edit-mode";
import { menuKeyOf } from "../helpers/menu-key";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");
const STEP = { past: [], future: [] };

function held(storage: Partial<ProfileStorage>): HeldStores {
  const stores = new HeldStores(
    {
      session: ephemeralSessionFile(),
      history: EPHEMERAL_HISTORY_STORAGE,
      ...storage,
    },
    () => {},
  );
  stores.load();
  return stores;
}

test("a history its file refuses throws, and the step is still held", () => {
  const stores = held({
    history: {
      load: () => new Map(),
      save: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    },
  });
  expect(() =>
    stores.take([
      { store: "settings-history", key: S1, value: STEP },
      { store: "session-state", key: S1, value: { pick: "a" } },
    ]),
  ).toThrow("ENOSPC: no space left on device");
  expect(stores.current().history[S1]).toEqual(STEP);
  expect(stores.current().sessions[S1]).toEqual({ pick: "a" });
});

// [LAW:no-silent-failure] A shutdown that lost state says so.
test("a close whose flush the file refuses rejects with the file's error", async () => {
  const refused = Object.assign(new Error("ENOSPC: no space"), {
    code: "ENOSPC",
  });
  const stores = held({
    session: {
      ...ephemeralSessionFile(),
      flush: () => Promise.reject(refused),
    },
  });
  await expect(stores.close()).rejects.toBe(refused);
});

test("writes taken after the close are held, and none is written", async () => {
  let saves = 0;
  const stores = held({
    history: { load: () => new Map(), save: () => void (saves += 1) },
  });
  await stores.close();
  stores.take([{ store: "settings-history", key: S1, value: STEP }]);
  expect(saves).toBe(0);
  expect(stores.current().history[S1]).toEqual(STEP);
});

test("a profile loads without the keys nothing reads, and a session left holding nothing takes no slot", () => {
  const S2 = sessionIdOf("s2");
  const logged: string[] = [];
  const live = menuKeyOf("picker", "applyTheme");
  const stores = new HeldStores(
    {
      session: {
        ...ephemeralSessionFile(),
        load: () =>
          new Map<SessionId, Record<string, string>>([
            [
              S1,
              {
                [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE,
                // Menu spellings no current derivation makes: a menu keyed by
                // its segment alone, its page cursor, edit chrome's collapsed
                // menu.
                "menus.picker.applyTheme": "applyTheme",
                "menupages.menus.picker.applyTheme": "2",
                "menus.edit_default_insertSeg": "x",
                // And a record of a failed click no build wrote.
                [CLICK_ERROR_KEY]: "x",
                [live]: "applyTheme",
                theme: "nord",
              },
            ],
            [S2, { [EDIT_CONFIGURE_KEY]: "default:clock" }],
          ]),
      },
      history: EPHEMERAL_HISTORY_STORAGE,
    },
    (_level, line) => logged.push(line),
  );
  stores.load();
  expect(stores.current().sessions).toEqual({
    [S1]: { [live]: "applyTheme", theme: "nord" },
  });
  expect(logged).toHaveLength(2);
  expect(logged[0]).toContain(CLICK_ERROR_KEY);
  expect(logged[0]).toContain("menus.picker.applyTheme");
});
