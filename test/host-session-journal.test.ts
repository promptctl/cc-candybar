import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MAIN_RENDERER,
  rendererNameOf,
} from "../src/daemon/foundations/renderer-name";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { HostSessions } from "../src/daemon/host-sessions";
import { SessionJournal } from "../src/daemon/session-journal";
import { profilePaths } from "../src/daemon/paths";
import { heldClock } from "./helpers/held-clock";
import type { Change } from "../src/renderer-interface/history-storage";

const main = MAIN_RENDERER,
  peer = rendererNameOf("peer"),
  sid = sessionIdOf("same");
const setting = (key: string, after: string): Change => ({
  kind: "session",
  key,
  before: null,
  after,
});
const layout = setting("padding", "4"),
  theme = setting("theme", "nord");
let dir: string;
const paths = () => ({
  state: dir,
  sessionState: path.join(dir, "session-state.json"),
  settingsHistory: path.join(dir, "settings-history.json"),
});
const named = () => profilePaths(paths(), peer);
const journal = () => path.join(dir, "shared-session", "changes");
const logs: string[] = [];
const clock = () => heldClock(new Date(1700000000000));
const build = (time = clock()) =>
  new HostSessions(
    new SessionJournal(paths(), time, (_, message) => logs.push(message)),
  );
const put = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-shared-profiles-"));
  logs.length = 0;
});
afterEach(() => fs.rmSync(dir, { force: true, recursive: true }));

test("imports both former profiles once, retains conflict sources byte for byte and accepts later v24 deletions, hearings and undo", async () => {
  put(paths().sessionState, {
    same: { theme: "from-primary", shared: "same" },
    older: { x: "1" },
  });
  put(named().sessionState, {
    same: { theme: "from-secondary", padding: "4", shared: "same" },
    named: { x: "2" },
  });
  put(paths().settingsHistory, { same: { past: [[theme]], future: [] } });
  put(named().settingsHistory, { same: { past: [[layout]], future: [] } });
  const original = fs.readFileSync(named().sessionState);
  const first = build();
  const reports = first.load();
  const merged = first.current(peer);
  expect(merged.sessions[sid]).toEqual({
    theme: "from-primary",
    padding: "4",
    shared: "same",
  });
  expect(merged.history[sid]).toEqual({
    past: [[theme], [layout]],
    future: [],
  });
  const report = reports.find((r) => r.store === "Session migration");
  expect(report?.file).toBe(named().sessionState);
  expect(JSON.stringify(report)).not.toContain("from-secondary");
  const archives = path.join(dir, "shared-session", "archive");
  expect(
    fs
      .readdirSync(archives)
      .some((f) => fs.readFileSync(path.join(archives, f)).equals(original)),
  ).toBe(true);
  expect(fs.readFileSync(named().sessionState)).toEqual(original);
  await first.close();
  expect(fs.readFileSync(paths().sessionState)).toEqual(
    fs.readFileSync(named().sessionState),
  );
  const exported = JSON.parse(fs.readFileSync(named().sessionState, "utf8"));
  delete exported.same.padding;
  const older = exported.older;
  delete exported.older;
  exported.older = older;
  put(named().sessionState, exported);
  put(named().settingsHistory, {
    same: { past: [[theme]], future: [[layout]] },
  });
  const next = build();
  expect(next.load().filter((r) => r.store === "Session migration")).toEqual(
    [],
  );
  const resumed = next.current(main);
  expect(resumed.sessions[sid]).toEqual({
    theme: "from-primary",
    shared: "same",
  });
  expect(Object.keys(resumed.sessions).at(-1)).toBe("older");
  expect(resumed.history[sid]).toEqual({ past: [[theme]], future: [[layout]] });
  await next.close();
  const again = build();
  expect(again.load().filter((r) => r.store === "Session migration")).toEqual(
    [],
  );
  expect(again.current(peer)).toEqual(resumed);
  await again.close();
});

test("an abrupt handoff recovers the journal before reconciling a conflicting rollback and keeps both versions", async () => {
  put(paths().sessionState, { same: { theme: "old", padding: "1" } });
  const first = build();
  first.load();
  first.take([
    {
      store: "session-state",
      kind: "patch",
      key: sid,
      changes: { theme: "newer" },
    },
  ]);
  // An unmanaged downgrade can see only the previous legacy export.
  expect(
    JSON.parse(fs.readFileSync(paths().sessionState, "utf8")).same.theme,
  ).toBe("old");
  put(paths().sessionState, { same: { theme: "rolled-back", padding: "2" } });
  fs.appendFileSync(journal(), "a partially appended last transaction");
  const next = build();
  const reports = next.load();
  expect(logs.some((m) => m.includes("recovered incomplete tail"))).toBe(true);
  expect(next.current(main).sessions[sid]).toEqual({
    theme: "newer",
    padding: "2",
  });
  const conflict = reports.find((r) => r.store === "Session migration");
  expect(JSON.stringify(conflict)).toContain("revision 1");
  expect(JSON.stringify(conflict)).not.toMatch(/rolled-back|newer/);
  const header = JSON.parse(
    fs
      .readFileSync(path.join(dir, "shared-session", "checkpoint"), "utf8")
      .slice(65),
  );
  const archived = (id: string) =>
    JSON.parse(
      fs.readFileSync(path.join(dir, "shared-session", "archive", id), "utf8"),
    );
  const recovery = archived(header.recovery);
  expect(recovery.recovered.sessions.same.theme).toBe("newer");
  expect(archived(recovery.sources.main.sessions).same.theme).toBe(
    "rolled-back",
  );
  expect(archived(recovery.basis.main.sessions).same.theme).toBe("old");
  await next.close();
});

test("a complete damaged journal line refuses startup without rewriting the evidence", () => {
  const first = build();
  first.load();
  first.take([
    {
      store: "session-state",
      kind: "patch",
      key: sid,
      changes: { theme: "nord" },
    },
  ]);
  const bad = fs.readFileSync(journal(), "utf8").replace("nord", "oops");
  fs.writeFileSync(journal(), bad);
  expect(() => build().load()).toThrow(
    /cannot recover session journal.*checksum/,
  );
  expect(fs.readFileSync(journal(), "utf8")).toBe(bad);
});

test("compaction racing a later click leaves its ordered suffix recoverable", async () => {
  const time = clock();
  const first = build(time);
  first.load();
  for (let i = 0; i < 256; i++)
    first.take([
      {
        store: "session-state",
        kind: "patch",
        key: sid,
        changes: { counter: String(i) },
      },
    ]);
  time.advance(0);
  first.take([
    {
      store: "session-state",
      kind: "patch",
      key: sid,
      changes: { counter: "after" },
    },
  ]);
  // The async checkpoint uses the filesystem thread pool. Observe publication
  // before constructing a replacement over the captured prefix and suffix.
  const end = Date.now() + 5000;
  for (;;) {
    const header = JSON.parse(
      fs
        .readFileSync(path.join(dir, "shared-session", "checkpoint"), "utf8")
        .slice(65),
    );
    if (
      header.revision === 256 &&
      fs.readFileSync(journal(), "utf8").trimEnd().split("\n").length === 1
    )
      break;
    if (Date.now() > end)
      throw new Error("the scheduled checkpoint was never published");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const next = build();
  next.load();
  expect(next.current(main).sessions[sid]).toEqual({ counter: "after" });
  await next.close();
});

test("a name first used after cutover gets a rollback export after the host dies, without having to reconnect", async () => {
  const first = build();
  first.load();
  first.current(peer);
  first.take([
    {
      kind: "patch",
      store: "session-state",
      key: sid,
      changes: { theme: "nord" },
    },
  ]);
  expect(fs.existsSync(named().sessionState)).toBe(false);
  const replacement = build();
  replacement.load();
  await replacement.close();
  expect(
    JSON.parse(fs.readFileSync(named().sessionState, "utf8")).same.theme,
  ).toBe("nord");
});

test("a click appends the same record with one or 128 pre-existing picks and a large prior history", async () => {
  const root = dir;
  const records: string[] = [];
  try {
    for (const count of [1, 128]) {
      dir = path.join(root, String(count));
      put(paths().sessionState, {
        same: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            "pick" + index,
            "unchanged",
          ]),
        ),
      });
      put(paths().settingsHistory, {
        same: {
          past: [[setting("prior", "x".repeat(count * 512))]],
          future: [],
        },
      });
      const first = build();
      first.load();
      first.take([
        {
          store: "session-state",
          kind: "patch",
          key: sid,
          changes: { padding: "4" },
        },
        {
          store: "settings-history",
          kind: "steps",
          key: sid,
          edits: [{ kind: "append", step: [layout] }],
        },
      ]);
      records.push(fs.readFileSync(journal(), "utf8"));
      await first.close();
    }
  } finally {
    dir = root;
  }
  expect(records[0]).toContain("padding");
  expect(records[0]).not.toContain("unchanged");
  expect(records[0]?.trimEnd().split("\n")).toHaveLength(1);
  expect(records[1]).toBe(records[0]);
});

test("an older renderer editing a partially published handoff retains all three file versions", async () => {
  put(named().sessionState, { same: { padding: "1" } });
  const old = fs.readFileSync(named().sessionState);
  const first = build();
  first.load();
  first.take([
    {
      store: "session-state",
      kind: "patch",
      key: sid,
      changes: { padding: "4" },
    },
    {
      store: "settings-history",
      kind: "steps",
      key: sid,
      edits: [{ kind: "append", step: [layout] }],
    },
  ]);
  fs.mkdirSync(named().settingsHistory);
  await expect(first.close()).rejects.toThrow();
  const intended = fs.readFileSync(named().sessionState);
  expect(JSON.parse(intended.toString()).same.padding).toBe("4");
  fs.rmdirSync(named().settingsHistory);
  put(named().sessionState, { same: { padding: "3", theme: "nord" } });
  const edited = fs.readFileSync(named().sessionState);
  const next = build();
  const reports = next.load();
  const report = reports.find((r) => r.store === "Interrupted session export");
  expect(report?.file).toBe(named().sessionState);
  if (report?.found.kind !== "reconciled")
    throw new Error("missing interrupted handoff report");
  const manifestFile = report.found.message.split(" kept in ").at(-1)!;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const read = (id: string) =>
    fs.readFileSync(path.join(path.dirname(manifestFile), id));
  expect(read(manifest.prior)).toEqual(old);
  expect(read(manifest.intended)).toEqual(intended);
  expect(read(manifest.observed)).toEqual(edited);
  expect(next.current(main).sessions[sid]).toEqual({
    padding: "4",
    theme: "nord",
  });
  await next.close();
  expect(fs.readFileSync(paths().sessionState)).toEqual(
    fs.readFileSync(named().sessionState),
  );
});

test("a refused append is held live and the next successful write makes both clicks recoverable", async () => {
  const first = build();
  first.load();
  fs.mkdirSync(journal());
  expect(() =>
    first.take([
      {
        kind: "patch",
        store: "session-state",
        key: sid,
        changes: { theme: "nord" },
      },
    ]),
  ).toThrow(/cannot append shared session journal/);
  expect(first.current(main).sessions[sid]?.theme).toBe("nord");
  fs.rmdirSync(journal());
  first.take([
    {
      kind: "patch",
      store: "session-state",
      key: sid,
      changes: { padding: "2" },
    },
  ]);
  const afterCrash = build();
  afterCrash.load();
  expect(afterCrash.current(main).sessions[sid]).toEqual({
    theme: "nord",
    padding: "2",
  });
  await afterCrash.close();
});
