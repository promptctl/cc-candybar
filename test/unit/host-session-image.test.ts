import { HostSessions } from "../../src/daemon/host-sessions";
import { rendererNameOf } from "../../src/daemon/foundations/renderer-name";
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
    const changes = image.prepare([write])().durable;
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

test("one host revision evicts the least recently heard pick and history across writers", () => {
  const ids = Array.from({ length: 256 }, (_, i) => sessionIdOf("held-" + i));
  const [heard, oldest] = ids;
  const extra = sessionIdOf("newcomer");
  const initial = {
    sessions: Object.fromEntries(ids.map((id) => [id, { theme: "nord" }])),
    history: Object.fromEntries(
      ids
        .slice(0, 32)
        .map((id) => [id, { past: [[change("theme", "nord")]], future: [] }]),
    ),
  };
  const host = new HostSessionImage(initial);
  const peer = new HostSessionImage(initial, "recovery");
  const disk = new HostSessionImage(initial, "recovery");
  const input: StoreWrite[] = [
    { store: "session-state", kind: "heard", key: heard! },
    { store: "settings-history", kind: "heard", key: heard! },
    {
      store: "session-state",
      kind: "patch",
      key: extra,
      changes: { padding: "2" },
    },
    {
      store: "settings-history",
      kind: "steps",
      key: extra,
      edits: [{ kind: "append", step: [change("padding", "2")] }],
    },
  ];
  const { writes, durable } = host.prepare(input)();
  expect(writes).toEqual([
    ...input,
    { store: "session-state", kind: "drop", key: oldest },
    {
      store: "settings-history",
      kind: "steps",
      key: oldest,
      edits: [{ kind: "clear" }],
    },
  ]);
  peer.prepare(writes)();
  disk.recover(durable);
  expect(peer.snapshot("live")).toEqual(host.snapshot("live"));
  expect(disk.snapshot("live")).toEqual(host.snapshot("durable"));
  expect(Object.keys(host.snapshot("live").sessions)).toHaveLength(256);
  expect(Object.keys(host.snapshot("live").history)).toHaveLength(32);
});

test("a private step can trim the oldest public step without reaching disk", () => {
  const initial = {
    sessions: {},
    history: { [a]: { past: [[change("theme", "nord")]], future: [] } },
  };
  const host = new HostSessionImage(initial);
  const disk = new HostSessionImage(initial, "recovery");
  const privateStep = [change(EDIT_MODE_KEY, "x".repeat(8 * 1024 * 1024))];
  const input: StoreWrite = {
    store: "settings-history",
    kind: "steps",
    key: a,
    edits: [{ kind: "append", step: privateStep }],
  };
  const { writes, durable } = host.prepare([input])();
  expect(writes.slice(1)).toEqual([
    {
      store: "settings-history",
      kind: "steps",
      key: a,
      edits: [{ kind: "trim", count: 1 }],
    },
  ]);
  expect(host.snapshot("live").history[a]?.past).toEqual([privateStep]);
  expect(JSON.stringify(durable).length).toBeLessThan(300);
  disk.recover(durable);
  expect(disk.snapshot("live")).toEqual(EMPTY_STORED_STATE);
  expect(host.snapshot("durable")).toEqual(EMPTY_STORED_STATE);
});

test("Back history is live across peers, its cap drops the oldest session, and a stale cursor cannot partly commit a pick", () => {
  const host = new HostSessionImage(EMPTY_STORED_STATE);
  const keys = Array.from({ length: 33 }, (_, i) => sessionIdOf("nav-" + i));
  const visit = (key: typeof a): StoreWrite => ({
    store: "navigation",
    kind: "navigate",
    key,
    edit: {
      kind: "visit",
      changes: [{ key: "custom.menu", from: null, to: "private-destination" }],
    },
  });
  for (const key of keys.slice(0, 32)) {
    expect(host.prepare([visit(key)])().durable).toEqual([]);
  }
  const newest = keys.at(-1)!;
  const { writes, durable } = host.prepare([visit(newest)])();
  expect(writes).toEqual([
    visit(newest),
    { store: "navigation", kind: "drop", key: keys[0] },
  ]);
  expect(durable).toEqual([]);
  expect(Object.keys(host.snapshot("live").navigation!)).toEqual(keys.slice(1));
  expect(host.snapshot("durable")).toEqual(EMPTY_STORED_STATE);
  expect(() =>
    host.prepare([
      {
        store: "session-state",
        kind: "patch",
        key: newest,
        changes: { padding: "3" },
      },
      {
        store: "navigation",
        kind: "navigate",
        key: newest,
        edit: { kind: "back", at: 2, discard: [] },
      },
    ]),
  ).toThrow(/expected cursor 2/);
  expect(host.snapshot("live").sessions).toEqual({});
  expect(host.snapshot("live").navigation![newest]?.cursor).toBe(1);
});

test("open drafts preserve explicit absence and private history only until the host lifetime ends", () => {
  const host = new HostSessionImage(EMPTY_STORED_STATE);
  const base = {
    origin: { projectDir: "/p", cwd: "/p", target: { source: "search" } },
    chain: [
      {
        role: "user",
        path: "/p/bar.json",
        content: { kind: "text", text: "{}" },
      },
    ],
  } as const;
  const take = (...writes: StoreWrite[]) => host.prepare(writes)();
  expect(
    take({ store: "draft", kind: "open", key: a, base, picks: {} }).durable,
  ).toEqual([]);
  expect(
    take({
      store: "draft",
      kind: "modify",
      key: a,
      changes: [
        { kind: "file", key: "/p/bar.json", value: null },
        { kind: "pick", key: "theme", value: null },
        {
          kind: "history",
          edit: { kind: "append", step: [change("theme", "private-secret")] },
        },
        { kind: "history", edit: { kind: "undo" } },
      ],
    }).durable,
  ).toEqual([]);
  const before = host.snapshot("live");
  expect(before.drafts?.[a]?.files).toEqual({ "/p/bar.json": null });
  expect(before.drafts?.[a]?.history.future).toEqual([
    [change("theme", "private-secret")],
  ]);
  expect(() =>
    take(
      {
        store: "session-state",
        kind: "patch",
        key: b,
        changes: { foo: "refused" },
      },
      {
        store: "draft",
        kind: "modify",
        key: a,
        changes: [
          { kind: "pick", key: "theme", value: "refused" },
          { kind: "history", edit: { kind: "undo" } },
        ],
      },
    ),
  ).toThrow();
  expect(host.snapshot("live")).toEqual(before);
  expect(
    take({
      store: "draft",
      kind: "modify",
      key: a,
      changes: [
        { kind: "file", key: "/p/bar.json" },
        { kind: "pick", key: "theme" },
      ],
    }).durable,
  ).toEqual([]);
  expect(host.snapshot("live").drafts?.[a]).toMatchObject({
    files: {},
    picks: {},
  });
  expect(host.snapshot("durable")).toEqual(EMPTY_STORED_STATE);
  expect(take({ store: "draft", kind: "close", key: a }).durable).toEqual([]);
  expect(host.snapshot("live")).toEqual(EMPTY_STORED_STATE);
});

test("session retirement closes an unsaved edit even when there is no renderer to answer", () => {
  const sessions = new HostSessions();
  sessions.load();
  sessions.take([
    {
      store: "draft",
      kind: "open",
      key: a,
      base: {
        origin: { projectDir: "/p", cwd: "/p", target: { source: "search" } },
        chain: [],
      },
      picks: {},
    },
  ]);
  const seen = jest.fn();
  sessions.retire(b, seen);
  expect(seen).not.toHaveBeenCalled();
  sessions.retire(a, seen);
  expect(seen).toHaveBeenCalledWith(2, [
    { store: "draft", kind: "close", key: a },
  ]);
  expect(
    sessions.current(rendererNameOf("replacement")).state.drafts,
  ).toBeUndefined();
  sessions.retire(a, seen);
  expect(seen).toHaveBeenCalledTimes(1);
});
