// Each per-session file keeps the order its sessions were last heard or
// written in, whatever their ids spell: an integer-like id ("7") is held at
// its place in recency, so the bound a restart applies drops the oldest.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
} from "../src/daemon/held-stores";
import { SessionState } from "../src/renderer/session-state";
import { SettingsHistory } from "../src/renderer/settings-history";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { systemTimekeeper } from "../src/time";
import { emptyStores } from "./helpers/doctor-facts";
import { heardRequest } from "./helpers/click";
import { TEST_ENVIRONMENT } from "./helpers/session-environment";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-file-recency-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The book's bound: as many sessions as it keeps.
const BOOK_BOUND = 256;

// Ids in recency order, oldest first, with integer-like ones among them and
// last: a record keyed by these would enumerate "12" and "7" first.
const recency = (count: number): string[] => [
  "oldest",
  ...Array.from({ length: count - 3 }, (_, i) => `s${i}`),
  "12",
  "7",
];

const durableRecord = (id: string) => ({
  projectDir: `/p/${id}`,
  cwd: `/p/${id}`,
  configFile: null,
  source: "search",
});

const logged = () => {
  const lines: string[] = [];
  return { lines, log: (_level: string, line: string) => lines.push(line) };
};

describe("the session book's file", () => {
  const bookOver = (file: string, log?: (l: string, m: string) => void) => {
    const book = new SessionBook(
      new SessionFile(SESSION_BOOK_FILE, file, systemTimekeeper, 0, log),
    );
    book.load();
    return book;
  };

  test("a file holding integer-like ids among others loads in its order, and the bound drops the oldest", async () => {
    const file = join(dir, "session-book.json");
    const ids = recency(BOOK_BOUND);
    writeFileSync(
      file,
      JSON.stringify(ids.map((id) => [id, durableRecord(id)])),
    );
    const book = bookOver(file);
    book.heard(heardRequest("newest", "/p/newest"), TEST_ENVIRONMENT);
    expect(book.contextOf(sessionIdOf("oldest"), null)).toBeNull();
    for (const id of ["s0", "12", "7", "newest"])
      expect(book.contextOf(sessionIdOf(id), null)).not.toBeNull();
    await book.close();
  });

  test("an integer-like id heard last is kept by the bound after a reload", async () => {
    const file = join(dir, "session-book.json");
    const first = bookOver(file);
    for (let i = 0; i < BOOK_BOUND - 1; i += 1)
      first.heard(heardRequest(`a${i}`, `/p/a${i}`), TEST_ENVIRONMENT);
    first.heard(heardRequest("7", "/p/7"), TEST_ENVIRONMENT);
    await first.close();
    expect(
      (JSON.parse(readFileSync(file, "utf8")) as Array<[string]>).at(-1)![0],
    ).toBe("7");

    const second = bookOver(file);
    second.heard(heardRequest("newer", "/p/newer"), TEST_ENVIRONMENT);
    expect(second.contextOf(sessionIdOf("a0"), null)).toBeNull();
    expect(second.contextOf(sessionIdOf("7"), null)?.durable).toEqual({
      origin: { projectDir: "/p/7", cwd: "/p/7", target: { source: "search" } },
    });
    await second.close();
  });

  test("a file keyed by session id is refused whole and said, never loaded reordered", async () => {
    const file = join(dir, "session-book.json");
    writeFileSync(
      file,
      JSON.stringify({ a: durableRecord("a"), "7": durableRecord("7") }),
    );
    const { lines, log } = logged();
    const book = bookOver(file, log);
    expect(book.contextOf(sessionIdOf("a"), null)).toBeNull();
    expect(book.contextOf(sessionIdOf("7"), null)).toBeNull();
    expect(lines).toContainEqual(
      "session-book load: a record keyed by session id, which keeps no recency order, starting empty",
    );
    await book.close();
  });

  test("an id that appears twice is said and its later entry dropped", async () => {
    const file = join(dir, "session-book.json");
    writeFileSync(
      file,
      JSON.stringify([
        ["a", durableRecord("a")],
        ["a", durableRecord("b")],
      ]),
    );
    const { lines, log } = logged();
    const book = bookOver(file, log);
    expect(book.contextOf(sessionIdOf("a"), null)?.durable.origin.cwd).toBe(
      "/p/a",
    );
    expect(lines).toContainEqual(
      'session-book load: dropped session key "a": session id appears twice',
    );
    await book.close();
  });
});

describe("the session picks' file", () => {
  test("a file holding integer-like ids among others reaches the renderer in its order, and the bound drops the oldest", async () => {
    const file = join(dir, "session-state.json");
    const ids = recency(5);
    writeFileSync(file, JSON.stringify(ids.map((id) => [id, { t: id }])));
    const stores = new HeldStores({
      session: new SessionFile(SESSION_STATE_FILE, file, systemTimekeeper, 0),
      history: EPHEMERAL_HISTORY_STORAGE,
      doctor: emptyStores(),
    });
    stores.load();
    expect(stores.current().sessions.map(([id]) => id)).toEqual(ids);
    const state = new SessionState(stores.current().sessions, 5);
    state.set(sessionIdOf("newest"), "t", "newest");
    stores.take(state.drain());
    await stores.close();
    expect(state.get(sessionIdOf("oldest"), "t")).toBeNull();
    expect(state.get(sessionIdOf("7"), "t")).toBe("7");
    expect(state.get(sessionIdOf("12"), "t")).toBe("12");
    expect(
      (JSON.parse(readFileSync(file, "utf8")) as Array<[string]>).map(
        ([id]) => id,
      ),
    ).toEqual([...ids.slice(1), "newest"]);
  });
});

describe("the settings history's file", () => {
  // The history's session bound.
  const HISTORY_BOUND = 32;
  const step = (id: string) => ({
    past: [[{ kind: "session", key: "theme", before: null, after: id }]],
    future: [],
  });

  test("a file holding integer-like ids among others reaches the renderer in its order, and the bound drops the oldest", () => {
    const file = join(dir, "settings-history.json");
    const ids = [...recency(HISTORY_BOUND), "99"];
    writeFileSync(file, JSON.stringify(ids.map((id) => [id, step(id)])));
    const stores = new HeldStores({
      session: ephemeralSessionFile(),
      history: fileHistoryStorage(file, () => {}),
      doctor: emptyStores(),
    });
    stores.load();
    expect(stores.current().history.map(([id]) => id)).toEqual(ids);
    const history = new SettingsHistory(
      new SessionState(),
      () => {},
      stores.current().history,
    );
    expect(history.depth(sessionIdOf("oldest")).undo).toBe(0);
    for (const id of ["s0", "12", "7", "99"])
      expect(history.depth(sessionIdOf(id)).undo).toBe(1);
  });

  test("a file keyed by session id is refused whole and said", () => {
    const file = join(dir, "settings-history.json");
    writeFileSync(file, JSON.stringify({ a: step("a"), "7": step("7") }));
    const { lines, log } = logged();
    expect([...fileHistoryStorage(file, log).load()]).toEqual([]);
    expect(lines).toEqual([
      "settings-history load: a record keyed by session id, which keeps no recency order, starting empty",
    ]);
  });
});
