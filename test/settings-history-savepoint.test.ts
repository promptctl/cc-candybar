// [LAW:verifiable-goals] The savepoint edit mode takes in the session's
// settings history (brandon-menu-ia-q30.3y8): how many steps lay behind when edit
// mode opened, so `✓ save N` can count what was done since and `↩ cancel` can
// step back to it. Every invariant here is one a transition could break: the
// opening click's own step, the cap, an undo below it, a restart, and a step
// whose target changed under it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionState } from "../src/daemon/session-state";
import {
  fileHistoryStorage,
  SettingsHistory,
} from "../src/daemon/settings-history";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import { readConfigText, writeConfigText } from "../src/daemon/config-file-store";

const SID = "s1";
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-savepoint-"));
  file = path.join(dir, "config.json5");
  fs.writeFileSync(file, "v0");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig(storage?: ConstructorParameters<typeof SettingsHistory>[2]) {
  const sessionState = new SessionState();
  const history = new SettingsHistory(sessionState, () => {}, storage);
  // One click that rewrites the config file: the file already holds `to` when
  // the journal is told, as a verb handler reports it.
  let n = 0;
  const edit = (): void => {
    const before = readConfigText(file);
    writeConfigText(file, `v${++n}`, () => {});
    const journal = history.begin();
    journal.file(SID, file, before, `v${n}`);
    journal.commit();
  };
  // One click that moves edit mode's key.
  const toggle = (to: string | null): void => {
    const journal = history.begin();
    if (to === null) journal.sessionState.clear(SID, EDIT_MODE_KEY);
    else journal.sessionState.set(SID, EDIT_MODE_KEY, to);
    journal.commit();
  };
  return { history, sessionState, edit, toggle };
}

describe("the savepoint is taken when edit mode opens and released when it closes", () => {
  test("changes made since it opened are counted, and closing releases them", () => {
    const { history, edit, toggle } = rig();
    edit();
    edit();
    toggle("arrange");
    expect(history.depth(SID)).toEqual({ undo: 2, redo: 0, sinceEdit: 0 });
    edit();
    expect(history.depth(SID)).toEqual({ undo: 3, redo: 0, sinceEdit: 1 });
    toggle("closed");
    expect(history.depth(SID)).toEqual({ undo: 3, redo: 0, sinceEdit: 0 });
    expect(history.history(SID).savepoint).toBeUndefined();
  });

  test("a click that opens edit mode and changes a setting counts that change as before it", () => {
    const { history, sessionState } = rig();
    const journal = history.begin();
    journal.sessionState.set(SID, "theme", "nord");
    journal.sessionState.set(SID, EDIT_MODE_KEY, "arrange");
    journal.commit();
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
  });

  test("clearing the key closes edit mode too", () => {
    const { history, edit, toggle } = rig();
    toggle("arrange");
    edit();
    toggle(null);
    expect(history.depth(SID).sinceEdit).toBe(0);
    expect(history.history(SID).savepoint).toBeUndefined();
  });

  test("moving the key between two open values neither takes nor releases one", () => {
    const { history, edit, toggle } = rig();
    toggle("arrange");
    edit();
    toggle("arrange");
    expect(history.depth(SID).sinceEdit).toBe(1);
  });
});

describe("the savepoint stays honest as the stack moves", () => {
  test("the cap drops the oldest steps and the savepoint moves down with them", () => {
    const { history, edit, toggle } = rig();
    for (let i = 0; i < 20; i++) edit();
    toggle("arrange"); // savepoint 20
    for (let i = 0; i < 40; i++) edit(); // 60 steps, 10 dropped from the front
    expect(history.depth(SID)).toEqual({ undo: 50, redo: 0, sinceEdit: 40 });
  });

  test("more edits than the stack holds count what it still holds, never more", () => {
    const { history, edit, toggle } = rig();
    toggle("arrange");
    for (let i = 0; i < 55; i++) edit();
    expect(history.depth(SID)).toEqual({ undo: 50, redo: 0, sinceEdit: 50 });
  });

  test("an undo below the savepoint leaves it, so stepping forward does not count older steps as edits", () => {
    const { history, edit, toggle } = rig();
    edit();
    edit();
    toggle("arrange");
    edit();
    history.undo(SID);
    expect(history.depth(SID).sinceEdit).toBe(0);
    history.undo(SID); // below the savepoint now
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 2, sinceEdit: 0 });
    history.redo(SID);
    expect(history.depth(SID)).toEqual({ undo: 2, redo: 1, sinceEdit: 0 });
    history.redo(SID);
    expect(history.depth(SID)).toEqual({ undo: 3, redo: 0, sinceEdit: 1 });
  });

  test("a fresh edit after an undo below the savepoint is an edit made in edit mode", () => {
    const { history, edit, toggle } = rig();
    edit();
    edit();
    toggle("arrange");
    history.undo(SID);
    history.undo(SID);
    edit();
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 1 });
  });

  test("a redo within edit mode's own steps counts them again", () => {
    const { history, edit, toggle } = rig();
    toggle("arrange");
    edit();
    edit();
    history.undo(SID);
    expect(history.depth(SID).sinceEdit).toBe(1);
    history.redo(SID);
    expect(history.depth(SID).sinceEdit).toBe(2);
  });
});

describe("rewind steps back to the savepoint", () => {
  test("restores the file, leaves no redo, and releases the savepoint", () => {
    const { history, edit, toggle } = rig();
    edit(); // v1: before edit mode
    toggle("arrange");
    edit(); // v2
    edit(); // v3
    const undone = history.rewind(SID);
    expect(undone).toHaveLength(2);
    expect(readConfigText(file)).toBe("v1");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    expect(history.history(SID).savepoint).toBeUndefined();
  });

  test("returns the stack to where edit mode found it, forward through steps ↶ took back below it", () => {
    const { history, edit, toggle } = rig();
    edit(); // v1
    edit(); // v2
    toggle("arrange");
    history.undo(SID); // v1: below the savepoint
    edit(); // v3 — a fresh edit made in edit mode, abandoning the redo of v2
    history.undo(SID); // v1 again
    history.undo(SID); // v0: below the savepoint
    expect(history.rewind(SID)).toEqual([]);
    expect(readConfigText(file)).toBe("v1");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
  });

  test("with nothing done since, undoes nothing", () => {
    const { history, edit, toggle } = rig();
    edit();
    toggle("arrange");
    expect(history.rewind(SID)).toEqual([]);
    expect(readConfigText(file)).toBe("v1");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
  });

  test("with no savepoint it refuses by name", () => {
    const { history, edit } = rig();
    edit();
    expect(() => history.rewind(SID)).toThrow(/no savepoint/);
    expect(readConfigText(file)).toBe("v1");
  });

  test("a file edited by hand since refuses loudly, keeps the hand edit, and releases the savepoint", () => {
    const { history, edit, toggle } = rig();
    toggle("arrange");
    edit(); // v1
    fs.writeFileSync(file, "hand edit");
    expect(() => history.rewind(SID)).toThrow(/changed since that edit/);
    expect(readConfigText(file)).toBe("hand edit");
    expect(history.history(SID).savepoint).toBeUndefined();
    expect(history.depth(SID).sinceEdit).toBe(0);
  });
});

describe("the savepoint survives a restart", () => {
  test("it is saved with the history and read back with it", () => {
    const historyFile = path.join(dir, "history.json");
    const first = rig(fileHistoryStorage(historyFile, () => {}));
    first.edit();
    first.toggle("arrange");
    first.edit();
    const second = new SettingsHistory(
      new SessionState(),
      () => {},
      fileHistoryStorage(historyFile, () => {}),
    );
    expect(second.depth(SID)).toEqual({ undo: 2, redo: 0, sinceEdit: 1 });
  });

  test("a savepoint past the end of the stack is a wrong-shaped file, dropped whole", () => {
    const historyFile = path.join(dir, "history.json");
    fs.writeFileSync(
      historyFile,
      JSON.stringify({ [SID]: { past: [], future: [], savepoint: 3 } }),
    );
    const logs: string[] = [];
    const storage = fileHistoryStorage(historyFile, (_level, m) => logs.push(m));
    expect(storage.load()).toEqual({});
    expect(logs.join("\n")).toMatch(/unexpected shape/);
  });

  test("a history written before savepoints existed loads with none", () => {
    const historyFile = path.join(dir, "history.json");
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        [SID]: {
          past: [[{ kind: "session", key: "theme", before: null, after: "x" }]],
          future: [],
        },
      }),
    );
    const history = new SettingsHistory(
      new SessionState(),
      () => {},
      fileHistoryStorage(historyFile, () => {}),
    );
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
  });
});
