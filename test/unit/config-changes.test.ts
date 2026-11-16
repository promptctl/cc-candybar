// [LAW:verifiable-goals] A config write as data: the changes a diff makes
// rebuild what was written byte for byte, a setting that moved refuses the
// whole list naming where, and a write elsewhere in the file refuses nothing.

import {
  applyChanges,
  diffChanges,
} from "../../src/config/config-changes";

const BEFORE = `{
  // the user's own
  globals: {
    padding: 1, // tight
    theme: "dusk",
    separator: " ",
  },
  presets: { calm: { padding: 2 } },
}
`;

// Each pair is a write a settings click makes; the diff must carry it whole.
const WRITES: ReadonlyArray<readonly [string, string | null, string | null]> =
  [
    ["a value set in place", BEFORE, BEFORE.replace("padding: 1", "padding: 3")],
    ["a key added last", BEFORE, BEFORE.replace(`separator: " ",`, `separator: " ",\n    shade: "dark",`)],
    ["a key removed from the middle", BEFORE, BEFORE.replace(`    theme: "dusk",\n`, "")],
    ["a key restored to the middle", BEFORE.replace(`    theme: "dusk",\n`, ""), BEFORE],
    ["a key restored first", BEFORE.replace("    padding: 1, // tight\n", ""), BEFORE],
    ["a preset copied", BEFORE, BEFORE.replace("presets: {", "presets: { mine: { padding: 3 },")],
    ["a file created", null, BEFORE],
    ["a file deleted", BEFORE, null],
    ["a file that does not parse, fixed", "{ globals: ", BEFORE],
  ];

describe("diffChanges", () => {
  test.each(WRITES)("%s rebuilds what was written", (_, before, after) => {
    expect(applyChanges(before, diffChanges(before, after))).toEqual({
      kind: "applied",
      text: after,
    });
  });

  test("a restored key is a change at its own setting, not the whole file", () => {
    const changes = diffChanges(
      BEFORE.replace(`    theme: "dusk",\n`, ""),
      BEFORE,
    );
    expect(changes).toEqual([
      {
        op: "insert",
        at: ["globals", "theme"],
        text: `"dusk"`,
        precedes: "separator",
      },
    ]);
  });

  // An undo of the first setting written into `globals: {}` cannot rebuild the
  // braces by removing the member, so it is a change at `globals` alone.
  test("an object its members cannot rebuild is changed whole, and nothing wider", () => {
    const empty = "{\n  globals: {},\n  root: 'bar',\n}\n";
    const pinned = `{\n  globals: {\n    palette: "dracula",\n  },\n  root: 'bar',\n}\n`;
    const undo = diffChanges(pinned, empty);
    expect(undo).toEqual([
      {
        op: "replace",
        at: ["globals"],
        text: "{}",
        read: { kind: "value", text: `{\n  palette: "dracula",\n}` },
      },
    ]);
    const elsewhere = pinned.replace("'bar'", "'git'");
    expect(applyChanges(elsewhere, undo)).toEqual({
      kind: "applied",
      text: empty.replace("'bar'", "'git'"),
    });
  });

  test("no write is no change", () => {
    expect(diffChanges(BEFORE, BEFORE)).toEqual([]);
  });
});

describe("applyChanges", () => {
  const set = diffChanges(BEFORE, BEFORE.replace("padding: 1", "padding: 3"));

  test("lands over a write to another setting of the same file", () => {
    const elsewhere = BEFORE.replace(`theme: "dusk"`, `theme: "noon"`);
    expect(applyChanges(elsewhere, set)).toEqual({
      kind: "applied",
      text: elsewhere.replace("padding: 1", "padding: 3"),
    });
  });

  test("a setting only reformatted has not moved", () => {
    const reformatted = BEFORE.replace("padding: 1", "padding: 1.0");
    expect(applyChanges(reformatted, set).kind).toBe("applied");
  });

  test("refuses a setting that moved, naming it and both values", () => {
    expect(
      applyChanges(BEFORE.replace("padding: 1", "padding: 5"), set),
    ).toEqual({
      kind: "moved",
      at: ["globals", "padding"],
      read: { kind: "value", text: "1" },
      found: { kind: "value", text: "5" },
    });
  });

  test("refuses at the ancestor that stopped being an object", () => {
    const flattened = BEFORE.replace(/globals: \{[^}]*\}/, "globals: 3");
    expect(applyChanges(flattened, set)).toEqual({
      kind: "moved",
      at: ["globals"],
      read: "object",
      found: { kind: "value", text: "3" },
    });
  });

  test("refuses an insert whose setting someone else added", () => {
    const insert = diffChanges(
      BEFORE,
      BEFORE.replace(`separator: " ",`, `separator: " ",\n    shade: "dark",`),
    );
    const added = BEFORE.replace(`separator: " ",`, `separator: " ",\n    shade: "light",`);
    expect(applyChanges(added, insert)).toMatchObject({
      kind: "moved",
      at: ["globals", "shade"],
      read: { kind: "absent" },
    });
  });

  test("refuses a setting in a file that no longer parses", () => {
    expect(applyChanges("{ globals: ", set)).toMatchObject({
      kind: "moved",
      at: [],
      read: "object",
    });
  });
});
