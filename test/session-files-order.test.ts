// [LAW:behavior-not-structure] Each bounded per-session store, saved through
// its own file and read back by a fresh store, evicts the session written
// longest ago: the session book, the session state and the settings history.
// Ids that look numeric keep their place among UUIDs; an array index, which a
// record would list first, never enters (test/session-id.test.ts), and a file
// holding one drops that entry by name.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";
import { PROTOCOL_VERSION } from "../src/daemon/foundations/protocol";
import { checkRenderRequest } from "../src/daemon/render-checkpoint";
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
import type { CheckedRenderRequest } from "../src/renderer-interface/request-context";
import { systemTimekeeper } from "../src/time";
import { NO_LAYERS } from "./helpers/history-step";
import { TEST_ENV, TEST_ENVIRONMENT } from "./helpers/session-environment";

// The sessions in the order they are written, oldest first: number-like ids
// that are no array index among UUIDs, then as many more as a bound needs.
const WRITTEN = [
  "07",
  "6a1f9a52-3c1e-4d7b-9e0a-2f4b8c6d1e01",
  "1e3",
  "6a1f9a52-3c1e-4d7b-9e0a-2f4b8c6d1e02",
  "4294967295",
  "6a1f9a52-3c1e-4d7b-9e0a-2f4b8c6d1e03",
];
const idsOf = (count: number): SessionId[] =>
  [
    ...WRITTEN,
    ...Array.from({ length: count - WRITTEN.length }, (_, i) => `session-${i}`),
  ].map(sessionIdOf);
// The session written after the file is read back.
const NEWEST = sessionIdOf("6a1f9a52-3c1e-4d7b-9e0a-2f4b8c6d1eff");

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

// [LAW:behavior-not-structure] A key no save can write, so this file alone is
// written by hand.
const writtenByHand = (record: Readonly<Record<string, unknown>>): void =>
  fs.writeFileSync(file, JSON.stringify(record));

const droppedKey = (store: string, key: string) =>
  expect(logged).toContainEqual(
    expect.stringContaining(
      `${store} load: dropped session key ${JSON.stringify(key)}: session id is ${JSON.stringify(key)}, an array index, which is never a session id`,
    ),
  );

// The host's held stores over the file, loaded as the daemon serves.
const heldOver = (storage: Partial<ProfileStorage>): HeldStores => {
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
};

describe("the session book's file", () => {
  // A statusline request of `session`, across the host's checkpoint.
  const request = (session: SessionId): CheckedRenderRequest => {
    const checked = checkRenderRequest(
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        hookData: {
          hook_event_name: "Status",
          session_id: session,
          transcript_path: "/p/transcript.jsonl",
          cwd: "/p",
          model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
          workspace: { current_dir: "/p", project_dir: "/p", added_dirs: [] },
        },
        args: ["cc-candybar"],
        cwd: "/p",
        env: TEST_ENV,
      },
      { firstSightOfUnknownHookField: () => false },
      () => {},
      "/nowhere/home",
    );
    if (!checked.ok) throw new Error(checked.problems.join("; "));
    return checked.req;
  };
  const bookOver = (): SessionBook => {
    const book = new SessionBook(
      new SessionFile(SESSION_BOOK_FILE, file, systemTimekeeper, 0, log),
    );
    book.load();
    return book;
  };
  const known = (book: SessionBook, id: SessionId): boolean =>
    book.contextOf(id, null) !== null;

  test("read back full, the book drops the session heard longest ago", async () => {
    // The book holds 256 sessions.
    const ids = idsOf(256);
    const first = bookOver();
    for (const id of ids) first.heard(request(id), TEST_ENVIRONMENT);
    await first.close();

    const second = bookOver();
    second.heard(request(NEWEST), TEST_ENVIRONMENT);
    expect(known(second, ids[0]!)).toBe(false);
    for (const id of ids.slice(1)) expect(known(second, id)).toBe(true);
    await second.close();
  });

  test("a key that is an array index is dropped by name", async () => {
    writtenByHand({
      a: SESSION_BOOK_FILE.record({
        origin: { projectDir: "/a", cwd: "/a", target: { source: "search" } },
      }),
      "7": SESSION_BOOK_FILE.record({
        origin: { projectDir: "/7", cwd: "/7", target: { source: "search" } },
      }),
    });
    const book = bookOver();
    expect(known(book, sessionIdOf("a"))).toBe(true);
    droppedKey("session-book", "7");
    await book.close();
  });
});

describe("the session state's file", () => {
  // A daemon over the file whose renderer holds `maxSessions`, each write
  // taken as a turn's are.
  const daemonOver = (maxSessions: number) => {
    const stores = heldOver({
      session: new SessionFile(
        SESSION_STATE_FILE,
        file,
        systemTimekeeper,
        0,
        log,
      ),
    });
    const state = new SessionState(stores.current().sessions, maxSessions);
    const write = (id: SessionId, theme: string): void => {
      state.set(id, "theme", theme);
      stores.take(state.drain());
    };
    return { state, write, stores };
  };

  test("read back full, the state drops the session written longest ago", async () => {
    const ids = idsOf(6);
    const first = daemonOver(6);
    ids.forEach((id, i) => first.write(id, `t${i}`));
    await first.stores.close();

    const second = daemonOver(6);
    second.write(NEWEST, "new");
    expect(second.state.get(ids[0]!, "theme")).toBeNull();
    ids
      .slice(1)
      .forEach((id, i) =>
        expect(second.state.get(id, "theme")).toBe(`t${i + 1}`),
      );
    await second.stores.close();
  });

  test("a key that is an array index is dropped by name", () => {
    writtenByHand({ a: { theme: "nord" }, "7": { theme: "dracula" } });
    const { state } = daemonOver(6);
    expect(state.get(sessionIdOf("a"), "theme")).toBe("nord");
    droppedKey("session-state", "7");
  });
});

describe("the settings history's file", () => {
  // A daemon over the file: a renderer's history built from what it holds,
  // each pick taken as a turn's are.
  const daemonOver = () => {
    const stores = heldOver({ history: fileHistoryStorage(file, log) });
    const history = new SettingsHistory(
      new SessionState(),
      log,
      stores.current().history,
    );
    const pick = (id: SessionId, theme: string): void => {
      const journal = history.begin(NO_LAYERS);
      journal.sessionState.set(id, "theme", theme);
      journal.commit();
      stores.take(history.drain());
    };
    return { history, pick, stores };
  };

  test("read back full, the history drops the session changed longest ago", async () => {
    // The history holds 32 sessions.
    const ids = idsOf(32);
    const first = daemonOver();
    ids.forEach((id, i) => first.pick(id, `t${i}`));
    await first.stores.close();

    const second = daemonOver();
    second.pick(NEWEST, "new");
    expect(second.history.depth(ids[0]!).undo).toBe(0);
    for (const id of ids.slice(1))
      expect(second.history.depth(id).undo).toBe(1);
    await second.stores.close();
  });

  // [LAW:behavior-not-structure] No save writes a retired key, so this file
  // is written by hand, as an older build left it.
  test("a history holding only retired changes takes no place in the bound", () => {
    const change = (key: string) => ({
      kind: "session",
      key,
      before: null,
      after: "x",
    });
    const real = sessionIdOf("6a1f9a52-3c1e-4d7b-9e0a-2f4b8c6d1e00");
    writtenByHand({
      [real]: { past: [[change("theme")]], future: [] },
      ...Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [
          `retired-${i}`,
          { past: [[change("look")]], future: [] },
        ]),
      ),
    });
    const { history } = daemonOver();
    expect(history.depth(real).undo).toBe(1);
    expect(logged).toContainEqual(
      `settings-history load: dropped session "retired-0": its value holds only changes to "look", no longer a setting`,
    );
    expect(logged).toContainEqual(
      "settings-history loaded sessions=1 dropped=32",
    );
  });

  test("a key that is an array index is dropped by name", () => {
    const step = {
      past: [[{ kind: "session", key: "theme", before: null, after: "x" }]],
      future: [],
    };
    writtenByHand({ a: step, "7": step });
    const { history } = daemonOver();
    expect(history.depth(sessionIdOf("a")).undo).toBe(1);
    droppedKey("settings-history", "7");
  });
});
