// The host's held stores: a write a file refuses is the turn's taking's
// failure, which the host says on every bar, and the write is still held.

import {
  EPHEMERAL_HISTORY_STORAGE,
  HeldStores,
  type ProfileStorage,
} from "../../src/daemon/held-stores";
import { ephemeralSessionFile } from "../../src/daemon/session-state-file";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { emptyStores } from "../helpers/doctor-facts";

const S1 = sessionIdOf("s1");
const STEP = { past: [], future: [] };

function held(storage: Partial<ProfileStorage>): HeldStores {
  const stores = new HeldStores({
    session: ephemeralSessionFile(),
    history: EPHEMERAL_HISTORY_STORAGE,
    doctor: emptyStores(),
    ...storage,
  });
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

test("a document its file refuses throws, and the copy is still held", () => {
  const doctor = emptyStores();
  const stores = held({
    doctor: {
      ...doctor,
      clicked: {
        ...doctor.clicked,
        update: () => ({ kind: "failed", reason: "EROFS: read-only" }),
      },
    },
  });
  expect(() => stores.take([{ store: "clicked", value: ["Ghostty"] }])).toThrow(
    "clicked not filed: EROFS: read-only",
  );
  expect(stores.current().doctor.clicked).toEqual({
    kind: "ok",
    value: ["Ghostty"],
  });
});

test("a document filed over one that did not read is refused, and nothing is written", () => {
  const doctor = emptyStores();
  let written = false;
  const stores = held({
    doctor: {
      ...doctor,
      marks: {
        ...doctor.marks,
        read: () => ({ kind: "failed", reason: "not JSON" }),
        update: () => {
          written = true;
          return { kind: "ok", value: {} };
        },
      },
    },
  });
  expect(() => stores.take([{ store: "marks", value: {} }])).toThrow(
    "the renderer filed marks, which did not read; nothing was written",
  );
  expect(written).toBe(false);
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
