// The host's held stores: a write a file refuses is the turn's taking's
// failure, which the host says on every bar, and the write is still held.

import {
  EPHEMERAL_HISTORY_STORAGE,
  HeldStores,
  type ProfileStorage,
} from "../../src/daemon/held-stores";
import { ephemeralSessionFile } from "../../src/daemon/session-state-file";
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

test("a profile loads without edit mode's keys, and a session left holding nothing takes no slot", () => {
  const S2 = sessionIdOf("s2");
  const logged: string[] = [];
  const stores = new HeldStores(
    {
      session: {
        ...ephemeralSessionFile(),
        load: () =>
          new Map<SessionId, Record<string, string>>([
            [S1, { "edit.mode": "arrange", theme: "nord" }],
            [S2, { "edit.configure": "default:clock" }],
          ]),
      },
      history: EPHEMERAL_HISTORY_STORAGE,
    },
    (_level, line) => logged.push(line),
  );
  stores.load();
  expect(stores.current().sessions).toEqual({ [S1]: { theme: "nord" } });
  expect(logged).toHaveLength(2);
});
