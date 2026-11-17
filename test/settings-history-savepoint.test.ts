// [LAW:verifiable-goals] The savepoint edit mode takes in the session's
// settings history (brandon-menu-ia-q30.3y8): what every target held when edit
// mode opened, so `↩ cancel` can put it all back whatever the stack did
// meanwhile. Every case here is one a transition could break: the opening
// click's own step, the cap, an undo below where edit mode opened, a fresh step
// after one, a target changed under it, and a restart.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionState } from "../src/renderer/session-state";
import { SettingsHistory } from "../src/renderer/settings-history";
import { StoredRegistry } from "../src/renderer/stored-registry";
import { historyOwner } from "../src/renderer/stored-owners";
import { profileStore } from "../src/daemon/profile-store";
import type { Effect } from "../src/renderer-interface/interface";
import type { StoredStore } from "../src/renderer-interface/stored";
import { emptyStoredState } from "../src/renderer-interface/stored";
import { heldClock } from "./helpers/held-clock";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import { readConfigText } from "../src/utils/atomic-write";
import {
  redoOf,
  rewindOf,
  undoOf,
  WRITES_IN_PLACE,
} from "./helpers/history-step";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const SID = sessionIdOf("s1");
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

function rig() {
  const sessionState = new SessionState();
  const history = new SettingsHistory(sessionState, () => {});
  // One click that rewrites the config file: the file already holds `to` when
  // the journal is told, as a verb handler reports it.
  let n = 0;
  const edit = (): void => {
    const before = readConfigText(file);
    fs.writeFileSync(file, `v${++n}`);
    const journal = history.begin(WRITES_IN_PLACE);
    journal.file(SID, file, before, `v${n}`);
    journal.commit();
  };
  // One click that picks a theme for the session.
  const pick = (theme: string): void => {
    const journal = history.begin(WRITES_IN_PLACE);
    journal.sessionState.set(SID, "theme", theme);
    journal.commit();
  };
  // One click that moves edit mode's key.
  const toggle = (to: string | null): void => {
    const journal = history.begin(WRITES_IN_PLACE);
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
    const journal = history.begin(WRITES_IN_PLACE);
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
    rewindOf(history, SID);
    expect(readConfigText(file)).toBe("v1");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    // A rewind alone leaves edit mode open, so it is cancellable again.
    edit(); // v4
    expect(history.depth(SID).sinceEdit).toBe(1);
    rewindOf(history, SID);
    expect(readConfigText(file)).toBe("v1");
    toggle("closed");
    expect(history.history(SID).savepoint).toBeUndefined();
  });

  test("an undo after cancel steps the change made before edit mode, never a discarded one", () => {
    const { history, edit, toggle } = rig();
    edit(); // v1
    toggle("arrange");
    edit(); // v2
    rewindOf(history, SID);
    undoOf(history, SID);
    expect(readConfigText(file)).toBe("v0");
    redoOf(history, SID);
    expect(readConfigText(file)).toBe("v1");
    expect(() => redoOf(history, SID)).toThrow(/nothing to redo/);
  });

  test("more edits than the stack holds are all put back", () => {
    const { history, edit, toggle } = rig();
    toggle("arrange");
    for (let i = 0; i < 55; i++) edit();
    expect(history.depth(SID).undo).toBe(50);
    rewindOf(history, SID);
    expect(readConfigText(file)).toBe("v0");
    expect(history.depth(SID)).toEqual({ undo: 0, redo: 0, sinceEdit: 0 });
  });

  test("a step ↶ took back below the savepoint is a change cancel puts back, and is past again", () => {
    const { history, edit, toggle } = rig();
    edit(); // v1
    edit(); // v2
    toggle("arrange");
    undoOf(history, SID); // v1
    undoOf(history, SID); // v0
    expect(history.depth(SID)).toEqual({ undo: 0, redo: 2, sinceEdit: 1 });
    rewindOf(history, SID);
    expect(readConfigText(file)).toBe("v2");
    expect(history.depth(SID)).toEqual({ undo: 2, redo: 0, sinceEdit: 0 });
    undoOf(history, SID);
    expect(readConfigText(file)).toBe("v1");
  });

  test("a fresh step after an undo below the savepoint does not cost cancel the undone change", () => {
    const { history, pick, edit, toggle, theme } = rig();
    pick("nord");
    toggle("arrange");
    undoOf(history, SID); // theme back to unset: below the savepoint
    edit(); // a layout edit, abandoning the redo of the theme pick
    expect(theme()).toBeNull();
    rewindOf(history, SID);
    expect(theme()).toBe("nord");
    expect(readConfigText(file)).toBe("v0");
  });

  test("with nothing done since, puts back nothing", () => {
    const { history, edit, toggle } = rig();
    edit();
    toggle("arrange");
    expect(rewindOf(history, SID)).toEqual([]);
    expect(readConfigText(file)).toBe("v1");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
  });

  test("with no savepoint it refuses by name", () => {
    const { history, edit } = rig();
    edit();
    expect(() => rewindOf(history, SID)).toThrow(/no savepoint/);
    expect(readConfigText(file)).toBe("v1");
  });

  test("a file edited by hand since is kept and named, and everything else is put back", () => {
    const { history, edit, pick, toggle, theme } = rig();
    toggle("arrange");
    pick("nord");
    edit(); // v1
    fs.writeFileSync(file, "hand edit");
    expect(() => rewindOf(history, SID)).toThrow(
      /changed since edit mode opened — kept as it is/,
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
    undoOf(history, SID); // v2: s3 below the savepoint
    undoOf(history, SID); // v1: s2 too
    edit(); // v4: abandons s2 and s3
    rewindOf(history, SID);
    expect(readConfigText(file)).toBe("v3");
    expect(history.depth(SID)).toEqual({ undo: 3, redo: 0, sinceEdit: 0 });
    undoOf(history, SID);
    expect(readConfigText(file)).toBe("v2");
    undoOf(history, SID);
    expect(readConfigText(file)).toBe("v1");
  });

  test("steps abandoned by two fresh steps keep their order", () => {
    const { history, edit, pick, toggle, theme } = rig();
    pick("a"); // p1
    pick("b"); // p2
    pick("c"); // p3
    toggle("arrange"); // at = 3
    undoOf(history, SID); // theme b
    edit(); // abandons p3; at = 2
    undoOf(history, SID); // undo the edit
    undoOf(history, SID); // theme a: p2 below
    edit(); // abandons the edit and p2; at = 1
    rewindOf(history, SID);
    expect(theme()).toBe("c");
    expect(readConfigText(file)).toBe("v0");
    undoOf(history, SID);
    expect(theme()).toBe("b");
    undoOf(history, SID);
    expect(theme()).toBe("a");
  });
});

describe("the savepoint under the history's bounds", () => {
  test("a net change alone over the byte bound releases the savepoint, said in the log", () => {
    const logs: string[] = [];
    const history = new SettingsHistory(new SessionState(), (_l, m) =>
      logs.push(m),
    );
    const toggle = history.begin(WRITES_IN_PLACE);
    toggle.sessionState.set(SID, EDIT_MODE_KEY, "arrange");
    toggle.commit();
    const big = history.begin(WRITES_IN_PLACE);
    big.sessionState.set(SID, "theme", "x".repeat(9 * 1024 * 1024));
    big.commit();
    expect(history.history(SID).savepoint).toBeUndefined();
    expect(logs.join("\n")).toMatch(/cancel is no longer available/);
  });

  test("a forgotten file that empties a step below the savepoint moves it down with the stack", () => {
    const { history, sessionState, pick, toggle, theme } = rig();
    const other = path.join(dir, "other.json5");
    fs.writeFileSync(other, "o0");
    const both = (): void => {
      const before = readConfigText(other);
      fs.writeFileSync(other, "o1");
      const journal = history.begin(WRITES_IN_PLACE);
      journal.file(SID, other, before, "o1");
      journal.commit();
    };
    both(); // A: changes `other`
    pick("nord"); // B
    toggle("arrange"); // at = 2
    // C: changes `other` and the theme, made in edit mode.
    const journal = history.begin(WRITES_IN_PLACE);
    fs.writeFileSync(other, "o2");
    journal.file(SID, other, "o1", "o2");
    journal.sessionState.set(SID, "theme", "gruvbox");
    journal.commit();
    // An undo of C, refused: `other` was edited by hand.
    fs.writeFileSync(other, "o hand");
    expect(() => undoOf(history, SID)).toThrow(/changed since that edit/);
    // A was only `other`, so it left; the savepoint counts B alone below it.
    expect(history.history(SID).savepoint?.at).toBe(1);
    rewindOf(history, SID);
    expect(theme()).toBe("nord");
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    undoOf(history, SID);
    expect(sessionState.get(SID, "theme")).toBeNull();
  });
});

// The history as a restart hands it back: drained as `store` writes, kept by
// the host's profile under `dir`, and restored through the history owner.
function kept(history: SettingsHistory): void {
  // A registry over a fresh profile, with the history as the case left it.
  const held = new Map(history.versions());
  const registry = new StoredRegistry([historyOwner(history, () => {})]);
  registry.restore(emptyStoredState());
  history.restore(held);
  const effects: Effect[] = [];
  registry.drain(effects);
  const profile = profileStore(
    dir,
    heldClock(new Date()),
    () => {},
    () => {},
  );
  for (const effect of effects)
    if (effect.kind === "store") profile.apply(effect);
  profile.close();
}

function restarted(logs: string[] = []): SettingsHistory {
  const history = new SettingsHistory(new SessionState(), () => {});
  const profile = profileStore(
    dir,
    heldClock(new Date()),
    () => {},
    () => {},
  );
  new StoredRegistry([
    historyOwner(history, (_level, m) => logs.push(m)),
  ]).restore(profile.stored());
  return history;
}

// A history restored from `entries` as a start hands them in, with what the
// owner said and the writes the first turn's end owes the host.
function restoredFrom(
  entries: Extract<StoredStore, { kind: "read" }>["entries"],
) {
  const logs: string[] = [];
  const history = new SettingsHistory(new SessionState(), () => {});
  const registry = new StoredRegistry([
    historyOwner(history, (_level, m) => logs.push(m)),
  ]);
  registry.restore({
    ...emptyStoredState(),
    history: { kind: "read", entries },
  });
  const effects: Effect[] = [];
  registry.drain(effects);
  return { history, logs, effects };
}

describe("the savepoint survives a restart", () => {
  test("it is kept with the history and read back with it, and cancels there", () => {
    const first = rig();
    first.edit();
    first.toggle("arrange");
    first.edit();
    kept(first.history);
    const second = restarted();
    expect(second.depth(SID)).toEqual({ undo: 2, redo: 0, sinceEdit: 1 });
    rewindOf(second, SID);
    expect(readConfigText(file)).toBe("v1");
  });

  // I-10: a stored history names a layer by its role, never by a path, so a
  // profile moved to another machine or home steps the same layers.
  test("what the history store keeps names no path", () => {
    const first = rig();
    first.edit();
    first.toggle("arrange");
    first.edit();
    kept(first.history);
    const text = fs.readFileSync(
      path.join(dir, "settings-history.json"),
      "utf8",
    );
    expect(text).toContain('"role":"user"');
    expect(text).not.toContain("/");
  });

  test("a savepoint of the wrong shape drops its history whole, said", () => {
    const { history, logs, effects } = restoredFrom({
      [SID]: { past: [], future: [], savepoint: 3 },
    });
    expect(history.versions().size).toBe(0);
    expect(logs).toEqual([
      "settings-history: dropped session s1: not a history",
    ]);
    // What was dropped is gone from the host's copy too.
    expect(effects).toEqual([
      { kind: "store", store: "history", key: SID, value: null },
    ]);
  });

  test("changes this build cannot step leave alone, named in the log", () => {
    // Steps recorded under `look` before it was renamed `style`, and a change
    // an older build named by its file's path: undoing either would restore
    // something nothing reads. Every other change, and every other session,
    // stays undoable.
    const change = (key: string) => ({
      kind: "session",
      key,
      before: null,
      after: "vivid",
    });
    const layer = { kind: "layer", role: "project", before: "a", after: "b" };
    const file = { kind: "file", file: "/c.json5", before: "a", after: "b" };
    const { history, logs, effects } = restoredFrom({
      [SID]: {
        past: [
          [change("look")],
          [change("style"), change("progression")],
          [file, layer],
          [file],
        ],
        future: [[change("look")]],
        savepoint: {
          at: 2,
          net: [change("look"), layer],
          below: [[change("look")]],
        },
      },
      other: { past: [[file]], future: [] },
    });
    expect(Object.fromEntries(history.versions())).toEqual({
      [SID]: {
        past: [[change("style")], [layer]],
        future: [],
        savepoint: { at: 1, net: [layer], below: [] },
      },
      other: { past: [], future: [] },
    });
    expect(logs).toEqual([
      'settings-history: dropped the changes this build cannot step: "look" (no longer a setting), "progression" (no longer a setting), a file an older build named by its path',
    ]);
    // The host's copy holds what this renderer holds.
    expect(effects.map((e) => e.kind === "store" && e.key).sort()).toEqual(
      [SID, "other"].sort(),
    );
  });

  test("a history written before savepoints existed restores with none", () => {
    const { history, effects } = restoredFrom({
      [SID]: {
        past: [[{ kind: "session", key: "theme", before: null, after: "x" }]],
        future: [],
      },
    });
    expect(history.depth(SID)).toEqual({ undo: 1, redo: 0, sinceEdit: 0 });
    expect(effects).toEqual([]);
  });
});
