// A config write as data: the changes between two documents, applied back
// byte for byte, and refused when what a change read has moved.

import {
  applyChanges,
  diffChanges,
  movedText,
  type Applied,
} from "../../src/config/config-changes";
import {
  deleteValue,
  insertSegmentRef,
  removeSegmentRef,
  setPlacementSetting,
  setValue,
  JSON5_DIALECT,
} from "../../src/config/json5-edit";

const CONFIG = `{
  // ─── header comment ───────────────────────────────────────────────
  globals: {
    theme: 'mocha', // the user's taste
    padding: 2,
  },

  /* a block comment between entries */
  segments: {
    git: { template: '{{ .branch }}' },
  },
  root: {
    h: [
      'directory', // where we are
      'git',
    ],
  },
  presets: {
    mine: { globals: { theme: 'nord' } },
  },
}
`;

const set = (text: string, path: readonly string[], value: string): string =>
  setValue(text, path, value, JSON5_DIALECT);

// [LAW:verifiable-goals] Every pair a writer makes: the changes between them,
// applied to the text they were taken from, give back the other text exactly,
// in both directions — what undo replays.
const PAIRS: ReadonlyArray<readonly [string, string | null, string | null]> = [
  ["a value replaced", CONFIG, set(CONFIG, ["globals", "theme"], "'nord'")],
  ["a key added to an object", CONFIG, set(CONFIG, ["globals", "style"], "'plain'")],
  ["a nested path made", CONFIG, set(CONFIG, ["themeDefaults", "nord", "style"], "'plain'")],
  ["a key removed", CONFIG, deleteValue(CONFIG, ["globals", "padding"])],
  ["an emptied object pruned", CONFIG, deleteValue(CONFIG, ["presets", "mine", "globals", "theme"], 2)],
  ["a placement inserted after, on its own line", CONFIG, insertSegmentRef(CONFIG, ["root"], { seg: "model" }, "directory", "after")],
  ["a placement inserted before, inline", `{ root: { h: ['a', 'b'] } }`, insertSegmentRef(`{ root: { h: ['a', 'b'] } }`, ["root"], { seg: "m", id: "m2" }, "b", "before")],
  ["a placement removed", CONFIG, removeSegmentRef(CONFIG, ["root"], "git")],
  ["a bare ref given its settings", CONFIG, setPlacementSetting(CONFIG, ["root"], "git", "width", "5")],
  ["a bare row wrapped", `{ root: { rows: { sys: 'demo' } } }`, removeSegmentRef(`{ root: { rows: { sys: ['demo', 'x'] } } }`, ["root"], "x")],
  ["a file created", null, `{\n  globals: { theme: 'nord' },\n}\n`],
  ["an empty file filled", "", `{ globals: {} }\n`],
  ["a CRLF document", CONFIG.replaceAll("\n", "\r\n"), set(CONFIG.replaceAll("\n", "\r\n"), ["globals", "theme"], "'nord'")],
];

describe("diffChanges and applyChanges", () => {
  test.each(PAIRS)("%s round-trips both ways", (_name, before, after) => {
    expect(applyChanges(before, diffChanges(before, after))).toEqual({
      kind: "applied",
      text: after,
    });
    expect(applyChanges(after, diffChanges(after, before))).toEqual({
      kind: "applied",
      text: before,
    });
  });

  test("a changed value is one set at its address, carrying what it read", () => {
    expect(diffChanges(CONFIG, set(CONFIG, ["globals", "theme"], "'nord'"))).toEqual([
      {
        op: "set",
        at: ["globals", "theme"],
        text: "'nord'",
        read: { kind: "value", value: "mocha" },
      },
    ]);
  });

  test("an insert replaces its row whole, in the writer's own text", () => {
    const after = insertSegmentRef(CONFIG, ["root"], { seg: "model" }, "directory", "after")!;
    const changes = diffChanges(CONFIG, after);
    expect(changes.map((c) => c.at)).toEqual([["root", "h"]]);
    expect(changes[0]!.op === "set" && changes[0]!.text).toContain("// where we are");
  });

  test("the same document is no change", () => {
    expect(diffChanges(CONFIG, CONFIG)).toEqual([]);
    expect(diffChanges(null, null)).toEqual([]);
  });

  test("a document taken back to nothing is removed", () => {
    expect(diffChanges(`{ a: 1 }`, null)).toEqual([
      { op: "remove", at: [], read: { a: 1 } },
    ]);
    expect(applyChanges(`{ a: 1 }`, diffChanges(`{ a: 1 }`, null))).toEqual({
      kind: "applied",
      text: null,
    });
  });

  test("a hand edit to a setting the change read refuses the whole change, naming it", () => {
    const after = set(set(CONFIG, ["globals", "theme"], "'nord'"), ["globals", "padding"], "3");
    const edited = set(CONFIG, ["globals", "padding"], "9");
    const result = applyChanges(edited, diffChanges(CONFIG, after));
    expect(result).toEqual({
      kind: "moved",
      at: ["globals", "padding"],
      read: { kind: "value", value: 2 },
      found: { kind: "value", value: 9 },
    });
    expect(movedText(result as Extract<Applied, { kind: "moved" }>)).toBe(
      "globals.padding changed since it was read: it was 2, and is now 9",
    );
  });

  test("a hand edit elsewhere in the file is kept", () => {
    const edited = set(CONFIG, ["segments", "git", "template"], "'{{ .sha }}'");
    const result = applyChanges(
      edited,
      diffChanges(CONFIG, set(CONFIG, ["globals", "theme"], "'nord'")),
    );
    expect(result).toEqual({
      kind: "applied",
      text: set(edited, ["globals", "theme"], "'nord'"),
    });
  });

  test("a setting made by hand where the change read nothing is refused", () => {
    const after = set(CONFIG, ["globals", "style"], "'plain'");
    const edited = set(CONFIG, ["globals", "style"], "'fancy'");
    expect(applyChanges(edited, diffChanges(CONFIG, after))).toMatchObject({
      kind: "moved",
      at: ["globals", "style"],
      read: { kind: "absent" },
      found: { kind: "value", value: "fancy" },
    });
  });

  test("a file made by hand where a change created it is refused", () => {
    expect(
      applyChanges(`{ b: 2 }`, diffChanges(null, `{ a: 1 }`)),
    ).toMatchObject({ kind: "moved", at: [], read: { kind: "absent" } });
  });
});
