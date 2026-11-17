// The host's copy of a renderer's stored state: read from its profile's files
// once, handed to each start whole, moved only by the `store` writes a turn
// returns, and written behind them.

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { profileStore } from "../src/daemon/profile-store";
import { DOCUMENT_KEY } from "../src/renderer-interface/stored";
import { heldClock } from "./helpers/held-clock";
import { jestTmpDir } from "./helpers/jest-tmp";

let dir: string;

beforeEach(() => {
  dir = jestTmpDir("state");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A profile over `dir` on a clock that never moves: nothing lands but by the
// close's flush, so what a case reads back is what the close wrote.
function opened(failed: string[] = []) {
  return profileStore(
    dir,
    heldClock(new Date()),
    (reason) => failed.push(reason),
    () => {},
  );
}

const fileOf = (name: string): unknown =>
  JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("what a start is handed", () => {
  test("a profile with no files hands in every store, empty", () => {
    const stored = opened().stored();
    for (const store of Object.values(stored))
      expect(store).toEqual({ kind: "read", entries: {} });
  });

  test("each store reads from the file an installed bar keeps it in", () => {
    writeFileSync(
      join(dir, "session-state.json"),
      JSON.stringify({ s1: { theme: "nord" } }),
    );
    writeFileSync(
      join(dir, "doctor-marks.json"),
      JSON.stringify({ tmux: { pane: "drawn" } }),
    );
    const stored = opened().stored();
    expect(stored.session).toEqual({
      kind: "read",
      entries: { s1: { theme: "nord" } },
    });
    expect(stored["doctor-marks"]).toEqual({
      kind: "read",
      entries: { [DOCUMENT_KEY]: { tmux: { pane: "drawn" } } },
    });
  });

  // [LAW:no-silent-failure] A file that does not read hands in why, which the
  // renderer says, until the renderer's first write replaces the store.
  test.each([
    ["not JSON", "{ not valid json", /^session-state\.json is not JSON: /],
    ["not an object", "[1, 2]", /^session-state\.json is not an object$/],
  ])("a keyed store's file that is %s hands in why", (_what, text, reason) => {
    writeFileSync(join(dir, "session-state.json"), text);
    const profile = opened();
    expect(profile.stored().session).toEqual({
      kind: "unreadable",
      reason: expect.stringMatching(reason),
    });
    profile.apply({
      kind: "store",
      store: "session",
      key: "s1",
      value: { theme: "nord" },
    });
    expect(profile.stored().session).toEqual({
      kind: "read",
      entries: { s1: { theme: "nord" } },
    });
  });
});

describe("what a write moves", () => {
  test("a write lands in memory at once, and a null write takes the entry away", () => {
    const profile = opened();
    profile.apply({
      kind: "store",
      store: "session",
      key: "s1",
      value: { a: "1" },
    });
    profile.apply({
      kind: "store",
      store: "session",
      key: "s2",
      value: { a: "2" },
    });
    profile.apply({ kind: "store", store: "session", key: "s1", value: null });
    expect(profile.stored().session).toEqual({
      kind: "read",
      entries: { s2: { a: "2" } },
    });
  });

  test("the close writes every store's file, owner-only, and a document whole", () => {
    const profile = opened();
    profile.apply({
      kind: "store",
      store: "session",
      key: "s1",
      value: { theme: "nord" },
    });
    profile.apply({
      kind: "store",
      store: "doctor-clicked",
      key: DOCUMENT_KEY,
      value: ["kitty"],
    });
    profile.close();
    expect(fileOf("session-state.json")).toEqual({ s1: { theme: "nord" } });
    expect(fileOf("doctor-clicked-terminals.json")).toEqual(["kitty"]);
    expect(statSync(join(dir, "session-state.json")).mode & 0o777).toBe(0o600);
  });

  test("a restart reads back what the close wrote", () => {
    const first = opened();
    first.apply({
      kind: "store",
      store: "history",
      key: "s1",
      value: { past: [], future: [] },
    });
    first.close();
    expect(opened().stored().history).toEqual({
      kind: "read",
      entries: { s1: { past: [], future: [] } },
    });
  });

  test("a document taken away reads back as no document after a restart", () => {
    const first = opened();
    first.apply({
      kind: "store",
      store: "doctor-marks",
      key: DOCUMENT_KEY,
      value: { marks: [] },
    });
    first.apply({
      kind: "store",
      store: "doctor-marks",
      key: DOCUMENT_KEY,
      value: null,
    });
    first.close();
    expect(opened().stored()["doctor-marks"]).toEqual({
      kind: "read",
      entries: {},
    });
  });

  // [LAW:no-ambient-temporal-coupling] What lands after a daemon closed stays
  // in memory: a late write can't land over the files a next daemon took up.
  test("a write after the close reaches memory and not the file", () => {
    const profile = opened();
    profile.apply({
      kind: "store",
      store: "session",
      key: "s1",
      value: { theme: "nord" },
    });
    profile.close();
    const closedWith = readFileSync(join(dir, "session-state.json"), "utf8");
    profile.apply({
      kind: "store",
      store: "session",
      key: "s1",
      value: { theme: "dracula" },
    });
    expect(profile.stored().session).toEqual({
      kind: "read",
      entries: { s1: { theme: "dracula" } },
    });
    profile.close();
    expect(readFileSync(join(dir, "session-state.json"), "utf8")).toBe(
      closedWith,
    );
  });

  test("a write the disk refuses is said for every bar", () => {
    rmSync(dir, { recursive: true, force: true });
    // The profile's directory is a regular file, so no store can be written.
    writeFileSync(dir, "");
    const failed: string[] = [];
    const profile = opened(failed);
    profile.apply({
      kind: "store",
      store: "session",
      key: "s1",
      value: { theme: "nord" },
    });
    profile.close();
    rmSync(dir, { force: true });
    expect(failed).toEqual([
      expect.stringMatching(/^session-state\.json save failed: /),
    ]);
  });

  test("a __proto__ key does not pollute Object.prototype and round-trips as data", () => {
    const first = opened();
    first.apply({
      kind: "store",
      store: "session",
      key: "__proto__",
      value: { theme: "evil" },
    });
    first.close();
    expect(({} as Record<string, unknown>)["theme"]).toBeUndefined();
    const stored = opened().stored().session;
    expect(stored.kind === "read" && Object.entries(stored.entries)).toEqual([
      ["__proto__", { theme: "evil" }],
    ]);
  });
});
