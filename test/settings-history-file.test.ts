import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionState } from "../src/renderer/session-state";
import { SettingsHistory } from "../src/renderer/settings-history";
import { fileHistoryStorage } from "../src/daemon/history-file";
import { NO_LAYERS } from "./helpers/history-step";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const SID = sessionIdOf("s1");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-history-file-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a lone step over the byte bound leaves no history behind, and the host is told it is gone", () => {
  const history = new SettingsHistory(new SessionState(), () => {});
  const big = history.begin(NO_LAYERS);
  big.sessionState.set(SID, "theme", "x".repeat(9 * 1024 * 1024));
  big.commit();
  expect(history.drain()).toEqual([
    { store: "settings-history", key: SID, value: null },
  ]);
});

test("retired setting keys and the obsolete savepoint leave committed history", () => {
  // brandon-rename-sweep-x4yf: steps recorded under `look` before it was
  // renamed `style`. Undoing one would restore a key nothing reads; every
  // other change, and every other session, stays undoable.
  const historyFile = path.join(dir, "history.json");
  const change = (key: string) => ({
    kind: "session",
    key,
    before: null,
    after: "vivid",
  });
  const file = {
    kind: "layer",
    role: "user",
    digest: "c",
    before: "a",
    after: "b",
  };
  fs.writeFileSync(
    historyFile,
    JSON.stringify({
      [SID]: {
        past: [
          [change("look")],
          [change("style"), change("progression")],
          [file],
        ],
        future: [[change("look")]],
        savepoint: {
          at: 2,
          net: [change("look"), file],
          below: [[change("look")]],
        },
      },
      other: { past: [[file]], future: [] },
    }),
  );
  const logs: string[] = [];
  const storage = fileHistoryStorage(historyFile, (_level, m) => logs.push(m));
  expect(Object.fromEntries(storage.load())).toEqual({
    [SID]: {
      past: [[change("style")], [file]],
      future: [],
    },
    other: { past: [[file]], future: [] },
  });
  expect(logs).toEqual([
    "settings-history loaded sessions=2 dropped=0",
    `settings-history load: session "${SID}" dropped the changes to "look", "progression", no longer a setting`,
  ]);
});
