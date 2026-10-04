// [LAW:verifiable-goals] The savepoint edit mode takes in the session's
// settings history (brandon-menu-ia-q30.3y8): what every target held when edit
// mode opened, so `↩ cancel` can put it all back whatever the stack did
// meanwhile. Every case here is one a transition could break: the opening
// click's own step, the cap, an undo below where edit mode opened, a fresh step
// after one, a target changed under it, and a restart.

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
  // One click that picks a theme for the session.
  const pick = (theme: string): void => {
    const journal = history.begin();
    journal.sessionState.set(SID, "theme", theme);
    journal.commit();
  };
  // One click that moves edit mode's key.
  const toggle = (to: string | null): void => {
    const journal = history.begin();
    if (to === null) journal.sessionState.clear(SID, EDIT_MODE_KEY);
    else journal.sessionState.set(SID, EDIT_MODE_KEY, to);
    journal.commit();
  };
  const theme = () => sessionState.get(SID, "theme");
  return { history, sessionState, edit, pick, toggle, theme };
}

describe("the savepoint is taken when edit mode opens and released when it closes", () => {
  test("it counts each target changed since it opened, and closing releases it", () => {
    const { history, edit, pick, toggle } = rig();
    edit();
    toggle("arrange");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    edit();
    edit();
    pick("nord");
    expect(history.depth(SID)).toEqual({ undo: 4, redo: 0, sinceEdit: 2 });
    toggle("closed");
    expect(history.depth(SID)).toEqual({ undo: 4, redo: 0, sinceEdit: 0 });
    expect(history.history(SID).savepoint).toBeUndefined();
  });

  test("a target changed and changed back differs from nothing", () => {
    const { history, pick, toggle } = rig();
    pick("nord");
    toggle("arrange");
    pick("gruvbox");
    expect(history.depth(SID).sinceEdit).toBe(1);
    pick("nord");
    expect(history.depth(SID).sinceEdit).toBe(0);
  });

  test("a click that opens edit mode and changes a setting counts that change as before it", () => {
    const { history, sessionState } = rig();
    const journal = history.begin();
    journal.sessionState.set(SID, "theme", "nord");
    journal.sessionState.set(SID, EDIT_MODE_KEY, "arrange");
    journal.commit();
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    expect(history.history(SID).savepoint).toEqual({
      at: 1,
      net: [],
      below: [],
    });
  });

  test("clearing the key closes edit mode too", () => {
    const { history, edit, toggle } = rig();
    toggle("arrange");
    edit();
    toggle(null);
    expect(history.history(SID).savepoint).toBeUndefined();
  });

  test("a value the edit-mode gate does not read as open takes no savepoint", () => {
    const { history, toggle } = rig();
    toggle("bogus");
    expect(history.history(SID).savepoint).toBeUndefined();
    toggle("arrange");
    expect(history.history(SID).savepoint).toBeDefined();
    toggle("arrange");
    expect(history.history(SID).savepoint).toBeDefined();
  });
});

describe("cancel puts back what edit mode found, whatever the stack did", () => {
  test("restores the file and leaves no redo; edit mode, still open, starts over from there", () => {
    const { history, edit, toggle } = rig();
    edit(); // v1: before edit mode
    toggle("arrange");
    edit(); // v2
    edit(); // v3
    history.rewind(SID);
    expect(readConfigText(file)).toBe("v1");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    // A rewind alone leaves edit mode open, so it is cancellable again.
    edit(); // v4
    expect(history.depth(SID).sinceEdit).toBe(1);
    history.rewind(SID);
    expect(readConfigText(file)).toBe("v1");
    toggle("closed");
    expect(history.history(SID).savepoint).toBeUndefined();
  });

  test("an undo after cancel steps the change made before edit mode, never a discarded one", () => {
    const { history, edit, toggle } = rig();
    edit(); // v1
    toggle("arrange");
    edit(); // v2
    history.rewind(SID);
    history.undo(SID);
    expect(readConfigText(file)).toBe("v0");
    history.redo(SID);
    expect(readConfigText(file)).toBe("v1");
    expect(() => history.redo(SID)).toThrow(/nothing to redo/);
  });

  test("more edits than the stack holds are all put back", () => {
    const { history, edit, toggle } = rig();
    toggle("arrange");
    for (let i = 0; i < 55; i++) edit();
    expect(history.depth(SID).undo).toBe(50);
    history.rewind(SID);
    expect(readConfigText(file)).toBe("v0");
    expect(history.depth(SID)).toEqual({ undo: 0, redo: 0, sinceEdit: 0 });
  });

  test("a step ↶ took back below the savepoint is a change cancel puts back, and is past again", () => {
    const { history, edit, toggle } = rig();
    edit(); // v1
    edit(); // v2
    toggle("arrange");
    history.undo(SID); // v1
    history.undo(SID); // v0
    expect(history.depth(SID)).toEqual({ undo: 0, redo: 2, sinceEdit: 1 });
    history.rewind(SID);
    expect(readConfigText(file)).toBe("v2");
    expect(history.depth(SID)).toEqual({ undo: 2, redo: 0, sinceEdit: 0 });
    history.undo(SID);
    expect(readConfigText(file)).toBe("v1");
  });

  test("a fresh step after an undo below the savepoint does not cost cancel the undone change", () => {
    const { history, pick, edit, toggle, theme } = rig();
    pick("nord");
    toggle("arrange");
    history.undo(SID); // theme back to unset: below the savepoint
    edit(); // a layout edit, abandoning the redo of the theme pick
    expect(theme()).toBeNull();
    history.rewind(SID);
    expect(theme()).toBe("nord");
    expect(readConfigText(file)).toBe("v0");
  });

  test("with nothing done since, puts back nothing", () => {
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

  test("a file edited by hand since is kept, everything else is put back, and the refusal names it", () => {
    const { history, edit, pick, toggle, theme } = rig();
    toggle("arrange");
    pick("nord");
    edit(); // v1
    fs.writeFileSync(file, "hand edit");
    expect(() => history.rewind(SID)).toThrow(
      /config\.json5 changed since edit mode opened — kept as it is/,
    );
    expect(readConfigText(file)).toBe("hand edit");
    expect(theme()).toBeNull();
    expect(history.depth(SID)).toEqual({ undo: 0, redo: 0, sinceEdit: 0 });
  });

  test("a fresh step that abandons steps from before edit mode keeps them for the stack cancel gives back", () => {
    const { history, edit, toggle } = rig();
    edit(); // v1
    edit(); // v2
    edit(); // v3
    toggle("arrange"); // at = 3
    history.undo(SID); // v2: s3 below the savepoint
    history.undo(SID); // v1: s2 too
    edit(); // v4: abandons s2 and s3
    history.rewind(SID);
    expect(readConfigText(file)).toBe("v3");
    expect(history.depth(SID)).toEqual({ undo: 3, redo: 0, sinceEdit: 0 });
    history.undo(SID);
    expect(readConfigText(file)).toBe("v2");
    history.undo(SID);
    expect(readConfigText(file)).toBe("v1");
  });

  test("steps abandoned by two fresh steps keep their order", () => {
    const { history, edit, pick, toggle, theme } = rig();
    pick("a"); // p1
    pick("b"); // p2
    pick("c"); // p3
    toggle("arrange"); // at = 3
    history.undo(SID); // theme b
    edit(); // abandons p3; at = 2
    history.undo(SID); // undo the edit
    history.undo(SID); // theme a: p2 below
    edit(); // abandons the edit and p2; at = 1
    history.rewind(SID);
    expect(theme()).toBe("c");
    expect(readConfigText(file)).toBe("v0");
    history.undo(SID);
    expect(theme()).toBe("b");
    history.undo(SID);
    expect(theme()).toBe("a");
  });
});

describe("the savepoint under the history's bounds", () => {
  test("a net change alone over the byte bound releases the savepoint, said in the log", () => {
    const logs: string[] = [];
    const history = new SettingsHistory(new SessionState(), (_l, m) =>
      logs.push(m),
    );
    const toggle = history.begin();
    toggle.sessionState.set(SID, EDIT_MODE_KEY, "arrange");
    toggle.commit();
    const big = history.begin();
    big.sessionState.set(SID, "theme", "x".repeat(9 * 1024 * 1024));
    big.commit();
    expect(history.history(SID).savepoint).toBeUndefined();
    expect(logs.join("\n")).toMatch(/cancel is no longer available/);
  });

  test("a refused undo that empties a step below the savepoint moves it down with the stack", () => {
    const { history, sessionState, pick, toggle, theme } = rig();
    const other = path.join(dir, "other.json5");
    fs.writeFileSync(other, "o0");
    const both = (): void => {
      const before = readConfigText(other);
      writeConfigText(other, "o1", () => {});
      const journal = history.begin();
      journal.file(SID, other, before, "o1");
      journal.commit();
    };
    both(); // A: changes `other`
    pick("nord"); // B
    toggle("arrange"); // at = 2
    // C: changes `other` and the theme, made in edit mode.
    const journal = history.begin();
    writeConfigText(other, "o2", () => {});
    journal.file(SID, other, "o1", "o2");
    journal.sessionState.set(SID, "theme", "gruvbox");
    journal.commit();
    fs.writeFileSync(other, "hand edit");
    expect(() => history.undo(SID)).toThrow(/changed since that edit/);
    // A was only `other`, so it left; the savepoint counts B alone below it.
    expect(history.history(SID).savepoint?.at).toBe(1);
    history.rewind(SID);
    expect(theme()).toBe("nord");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    history.undo(SID);
    expect(sessionState.get(SID, "theme")).toBeNull();
  });
});

describe("the savepoint survives a restart", () => {
  test("it is saved with the history and read back with it, and cancels there", () => {
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
    second.rewind(SID);
    expect(readConfigText(file)).toBe("v1");
  });

  test("a savepoint of the wrong shape is a wrong-shaped file, dropped whole", () => {
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

  test("changes to a key that is no longer a setting leave alone, named in the log", () => {
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
    const file = { kind: "file", file: "/c.json5", before: "a", after: "b" };
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        [SID]: {
          past: [[change("look")], [change("style"), change("progression")], [file]],
          future: [[change("look")]],
          savepoint: { at: 2, net: [change("look"), file], below: [[change("look")]] },
        },
        other: { past: [[file]], future: [] },
      }),
    );
    const logs: string[] = [];
    const storage = fileHistoryStorage(historyFile, (_level, m) => logs.push(m));
    expect(storage.load()).toEqual({
      [SID]: {
        past: [[change("style")], [file]],
        future: [],
        savepoint: { at: 1, net: [file], below: [] },
      },
      other: { past: [[file]], future: [] },
    });
    expect(logs).toEqual([
      'settings-history load: dropped the changes to "look", "progression", no longer a setting',
    ]);
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
