// [LAW:behavior-not-structure] Each bounded per-session store reads its file
// back in the order the sessions were written, and its bound evicts the oldest
// of them: the session book, the session state and the settings history. Ids
// that look numeric keep their place; an array index, which a record would
// list first, never enters (test/session-id.test.ts), and a file holding one
// drops that entry by name.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { SESSION_BOOK_FILE, SessionBook } from "../src/daemon/session-book";
import {
  SESSION_STATE_FILE,
  SessionFile,
  ephemeralSessionFile,
} from "../src/daemon/session-state-file";
import { fileHistoryStorage } from "../src/daemon/history-file";
import {
  EPHEMERAL_HISTORY_STORAGE,
  HeldStores,
  type ProfileStorage,
} from "../src/daemon/held-stores";
import { SessionState } from "../src/renderer/session-state";
import { SettingsHistory } from "../src/renderer/settings-history";
import type { SessionHistory } from "../src/renderer-interface/history-storage";
import type { DurableContext } from "../src/renderer-interface/request-context";
import { systemTimekeeper } from "../src/time";
import { emptyStores } from "./helpers/doctor-facts";

// Oldest first. Numeric-looking ids that are no array index, among others.
const LOOKS_NUMERIC = ["4294967295", "07", "1e3", "-1"];
const idsOf = (count: number): string[] => [
  ...LOOKS_NUMERIC,
  ...Array.from({ length: count - LOOKS_NUMERIC.length }, (_, i) => `s${i}`),
];

let dir: string;
let file: string;
let logged: string[];
const log = (_level: string, line: string): void => void logged.push(line);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-session-files-order-"));
  file = path.join(dir, "store.json");
  logged = [];
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The file as a store wrote it: each id's entry, in the order given.
const written = (entries: ReadonlyArray<readonly [string, unknown]>): void =>
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(entries)));

const dropped = (store: string, key: string) =>
  expect(logged).toContainEqual(
    expect.stringContaining(
      `${store} load: dropped session key ${JSON.stringify(key)}: session id is ${JSON.stringify(key)}, an array index`,
    ),
  );

// The host's held stores over the file, handed to a renderer as it is built.
const heldOver = (storage: Partial<ProfileStorage>): HeldStores => {
  const stores = new HeldStores({
    session: ephemeralSessionFile(),
    history: EPHEMERAL_HISTORY_STORAGE,
    doctor: emptyStores(),
    ...storage,
  });
  stores.load();
  return stores;
};

describe("the session book's file", () => {
  const durable = (at: string): DurableContext => ({
    origin: { projectDir: at, cwd: at, target: { source: "search" } },
  });
  const bookOver = (): SessionBook => {
    const book = new SessionBook(
      new SessionFile(SESSION_BOOK_FILE, file, systemTimekeeper, 0, log),
    );
    book.load();
    return book;
  };
  const known = (book: SessionBook, id: string): boolean =>
    book.contextOf(sessionIdOf(id), null) !== null;

  test("a book over its bound drops the session heard longest ago", async () => {
    const ids = idsOf(257);
    written(
      ids.map((id, i) => [id, SESSION_BOOK_FILE.record(durable(`/p${i}`))]),
    );
    const book = bookOver();
    expect(known(book, ids[0]!)).toBe(false);
    for (const id of ids.slice(1)) expect(known(book, id)).toBe(true);
    await book.close();
  });

  test("a key that is an array index is dropped by name", async () => {
    written([
      ["a", SESSION_BOOK_FILE.record(durable("/a"))],
      ["7", SESSION_BOOK_FILE.record(durable("/7"))],
    ]);
    const book = bookOver();
    expect(known(book, "a")).toBe(true);
    dropped("session-book", "7");
    await book.close();
  });
});

describe("the session state's file", () => {
  const stateOver = (maxSessions: number) =>
    new SessionState(
      heldOver({
        session: new SessionFile(
          SESSION_STATE_FILE,
          file,
          systemTimekeeper,
          0,
          log,
        ),
      }).current().sessions,
      maxSessions,
    );

  test("a state over its bound drops the session written longest ago", () => {
    const ids = idsOf(6);
    written(ids.map((id, i) => [id, { theme: `t${i}` }]));
    const state = stateOver(5);
    expect(state.get(sessionIdOf(ids[0]!), "theme")).toBeNull();
    ids
      .slice(1)
      .forEach((id, i) =>
        expect(state.get(sessionIdOf(id), "theme")).toBe(`t${i + 1}`),
      );
  });

  test("a key that is an array index is dropped by name", () => {
    written([
      ["a", { theme: "nord" }],
      ["7", { theme: "dracula" }],
    ]);
    const state = stateOver(5);
    expect(state.get(sessionIdOf("a"), "theme")).toBe("nord");
    dropped("session-state", "7");
  });
});

describe("the settings history's file", () => {
  // A history of one step that picked `theme`.
  const picked = (theme: string): SessionHistory => ({
    past: [[{ kind: "session", key: "theme", before: null, after: theme }]],
    future: [],
  });
  const historyOver = (): SettingsHistory =>
    new SettingsHistory(
      new SessionState(),
      log,
      heldOver({ history: fileHistoryStorage(file, log) }).current().history,
    );
  const undoes = (history: SettingsHistory, id: string): number =>
    history.depth(sessionIdOf(id)).undo;

  test("a history over its bound drops the session changed longest ago", () => {
    // The history holds 32 sessions.
    const ids = idsOf(33);
    written(ids.map((id, i) => [id, picked(`t${i}`)]));
    const history = historyOver();
    expect(undoes(history, ids[0]!)).toBe(0);
    for (const id of ids.slice(1)) expect(undoes(history, id)).toBe(1);
  });

  test("a key that is an array index is dropped by name", () => {
    written([
      ["a", picked("nord")],
      ["7", picked("dracula")],
    ]);
    const history = historyOver();
    expect(undoes(history, "a")).toBe(1);
    dropped("settings-history", "7");
  });
});
