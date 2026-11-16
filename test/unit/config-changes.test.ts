// [LAW:behavior-not-structure] A config write as changes: applied to the text
// they were made from, they give back the text written, comments and all; and
// applied to a file that moved under them, they refuse, naming the setting.

import {
  applyChanges,
  diffChanges,
  type Applied,
} from "../../src/config/config-changes";

const FILE = `// my bar
{
  globals: {
    theme: "nord", // the one I like
    shade: 3,
  },
  presets: {
    work: { root: { rows: { main: ["git", "model"] } } },
    play: {},
  },
}
`;

const roundTrip = (before: string | null, after: string | null): void =>
  expect(applyChanges(before, diffChanges(before, after))).toEqual({
    kind: "applied",
    text: after,
  });

describe("diffChanges then applyChanges gives back what was written", () => {
  test.each([
    ["a value changed", FILE.replace('"nord"', '"dracula"')],
    ["a value added at an object's end", FILE.replace("shade: 3,", "shade: 3,\n    style: \"round\",")],
    ["a value removed", FILE.replace('    shade: 3,\n', "")],
    ["a row edited", FILE.replace('["git", "model"]', '["git", "cost", "model"]')],
    ["a preset added", FILE.replace("play: {},", "play: {},\n    calm: { from: \"work\" },")],
    ["a preset removed", FILE.replace("    play: {},\n", "")],
    ["a key restored mid-object", FILE.replace("  globals: {", "  extra: 1,\n  globals: {")],
    ["a comment edited", FILE.replace("the one I like", "the one I love")],
  ])("%s", (_, after) => roundTrip(FILE, after));

  test("a first write creates the file, and its undo deletes it", () => {
    roundTrip(null, FILE);
    roundTrip(FILE, null);
  });

  test("a file that does not parse is replaced whole, and only over the same bytes", () => {
    const broken = "{ globals: { theme: ";
    roundTrip(broken, FILE);
    roundTrip(FILE, broken);
    expect(applyChanges(`${broken} `, diffChanges(broken, FILE))).toMatchObject({
      kind: "moved",
      at: [],
    });
  });

  test("a changed value is one change at its setting, keeping the line's comment", () => {
    const after = FILE.replace('"nord"', '"dracula"');
    expect(diffChanges(FILE, after)).toEqual([
      {
        op: "set",
        at: ["globals", "theme"],
        text: '"dracula"',
        read: { kind: "value", text: '"nord"' },
      },
    ]);
  });
});

describe("a setting that moved refuses the whole list", () => {
  const changes = diffChanges(FILE, FILE.replace("shade: 3", "shade: 4"));

  test("a hand edit elsewhere in the file does not refuse it", () => {
    const edited = FILE.replace('"nord"', '"solarized"');
    expect(applyChanges(edited, changes)).toEqual({
      kind: "applied",
      text: edited.replace("shade: 3", "shade: 4"),
    });
  });

  test("a hand edit to the setting refuses it, saying what it found", () => {
    expect(applyChanges(FILE.replace("shade: 3", "shade: 7"), changes)).toEqual<Applied>({
      kind: "moved",
      at: ["globals", "shade"],
      read: { kind: "value", text: "3" },
      found: { kind: "value", text: "7" },
    });
  });

  test("a container that is gone is a moved setting, not an error", () => {
    const set = diffChanges(FILE, FILE.replace("shade: 3,", "shade: 3,\n    style: \"round\","));
    const outcome = applyChanges(FILE.replace("globals: {", "globals: 5, old: {"), set);
    expect(outcome.kind).toBe("moved");
  });

  test("a file broken by hand under a change refuses it, saying what the file holds", () => {
    expect(applyChanges("{ globals: ", changes)).toEqual<Applied>({
      kind: "moved",
      at: ["globals", "shade"],
      read: { kind: "value", text: "3" },
      found: { kind: "file", text: "{ globals: " },
    });
  });

  test("a file deleted under a change refuses it", () => {
    expect(applyChanges(null, changes)).toMatchObject({
      kind: "moved",
      at: ["globals", "shade"],
      found: { kind: "absent" },
    });
  });
});
