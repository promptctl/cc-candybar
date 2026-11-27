import { HostSessionImage } from "../../src/daemon/host-session-image";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import {
  EMPTY_STORED_STATE,
  type StoreWrite,
} from "../../src/renderer-interface/stored-state";
import { EDIT_MODE_KEY } from "../../src/config/reserved-names";
import type {
  HistoryEdit,
  Step,
} from "../../src/renderer-interface/history-storage";
const a = sessionIdOf("a"),
  b = sessionIdOf("b");
const change = (key: string, value: string): Step[number] => ({
  kind: "session",
  key,
  before: null,
  after: value,
});

test("a journal prefix equals the durable projection after every cap, private edit, stale target and stack move", () => {
  const image = new HostSessionImage(EMPTY_STORED_STATE);
  const disk = new HostSessionImage(EMPTY_STORED_STATE);
  const take = (write: StoreWrite) => {
    const changes = image.prepare([write])();
    const json = JSON.stringify(changes);
    expect(json).not.toContain("private-secret");
    expect(json).not.toContain(EDIT_MODE_KEY);
    disk.recover(JSON.parse(json));
    const projected = image.snapshot("durable");
    expect(disk.snapshot("live")).toEqual(projected);
    expect(Object.keys(disk.snapshot("live").history)).toEqual(
      Object.keys(projected.history),
    );
  };
  const edit = (...edits: HistoryEdit[]) =>
    take({ kind: "steps", store: "settings-history", key: a, edits });
  const pub = change("theme", "nord"),
    priv = change(EDIT_MODE_KEY, "private-secret");
  take({
    kind: "patch",
    store: "session-state",
    key: a,
    changes: { theme: "nord", [EDIT_MODE_KEY]: "private-secret" },
  });
  take({
    kind: "patch",
    store: "session-state",
    key: b,
    changes: { some: "thing" },
  });
  take({
    kind: "patch",
    store: "session-state",
    key: a,
    changes: { [EDIT_MODE_KEY]: null },
  });
  for (let i = 0; i < 62; i++)
    edit({
      kind: "append",
      step: i % 3 === 0 ? [priv] : i % 3 === 1 ? [pub] : [pub, priv],
    });
  for (let i = 0; i < 50; i++) edit({ kind: "undo" });
  for (let i = 0; i < 25; i++) edit({ kind: "redo" });
  edit({ kind: "append", step: [priv] });
  edit({ kind: "forget", targets: [{ kind: "session", key: EDIT_MODE_KEY }] });
  edit({ kind: "trim", count: 2 });
  edit({ kind: "clear" });
});

test("an invalid relative edit refuses its whole transaction", () => {
  const image = new HostSessionImage(EMPTY_STORED_STATE);
  expect(() =>
    image.prepare([
      {
        store: "session-state",
        kind: "patch",
        key: a,
        changes: { theme: "nord" },
      },
      {
        store: "settings-history",
        kind: "steps",
        key: a,
        edits: [{ kind: "undo" }],
      },
    ]),
  ).toThrow(/empty stack/);
  expect(image.snapshot("live")).toEqual(EMPTY_STORED_STATE);
});
