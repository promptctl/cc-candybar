// [LAW:behavior-not-structure] What each producer of a load's advisories says
// it is about. The bar's viewer names an advisory by that, so the contract is
// what stays put and what does not: fixing one advisory leaves another's
// identity alone, whatever its words (a line, a reason) become, and two things
// that are not alike are two advisories, from one producer or from two.

import { editabilityNotice } from "../../src/config/loader/diagnostics";
import { payloadDeclarationNotices } from "../../src/config/loader/reserved-namespace";
import { droppedPluginAdvisory } from "../../src/config/loader/plugins";
import { insertNotice, type Miss } from "../../src/config/presets";
import type { InsertCell } from "../../src/config/dsl-types";

const FILE = "/home/u/.cc-candybar.json5";

// Two payload-owned declarations, then the same file with the first removed:
// the second moves up a line.
const BOTH = `{
  variables: {
    "session.id": { kind: "literal", value: "x" },
    hover: { kind: "literal", value: "y" },
  },
}
`;
const SECOND_ALONE = `{
  variables: {
    hover: { kind: "literal", value: "y" },
  },
}
`;

describe("a declaration the payload owns", () => {
  test("is the same advisory after another is fixed, and its line moved", () => {
    const [, hover] = payloadDeclarationNotices(FILE, BOTH, [
      "session.id",
      "hover",
    ]);
    const [alone] = payloadDeclarationNotices(FILE, SECOND_ALONE, ["hover"]);
    expect(alone!.message).not.toBe(hover!.message);
    expect(alone!.subject).toEqual(hover!.subject);
  });

  test("is another advisory for another name", () => {
    const [first, second] = payloadDeclarationNotices(FILE, BOTH, [
      "session.id",
      "hover",
    ]);
    expect(first!.subject).not.toEqual(second!.subject);
  });
});

describe("a file the settings menu cannot edit", () => {
  const DUPLICATE = `{ globals: {\n padding: 1,\n padding: 2,\n} }\n`;
  const SHIFTED = `// a comment\n${DUPLICATE}`;

  test("is the same advisory when the duplicate's line moves", () => {
    const before = editabilityNotice(FILE, DUPLICATE)!;
    const after = editabilityNotice(FILE, SHIFTED)!;
    expect(after.message).not.toBe(before.message);
    expect(after.subject).toEqual(before.subject);
  });

  test("is another advisory for another file", () => {
    expect(editabilityNotice("/other.json5", DUPLICATE)!.subject).not.toEqual(
      editabilityNotice(FILE, DUPLICATE)!.subject,
    );
  });
});

test("a dropped plugin is the same advisory when its reason changes, and another for another plugin", () => {
  const dropped = (path: string, reason: string) =>
    droppedPluginAdvisory({ path, reason } as Parameters<
      typeof droppedPluginAdvisory
    >[0]);
  expect(dropped("/p/a/plugin.json5", "no template").subject).toEqual(
    dropped("/p/a/plugin.json5", "unknown key").subject,
  );
  expect(dropped("/p/a/plugin.json5", "no template").subject).not.toEqual(
    dropped("/p/b/plugin.json5", "no template").subject,
  );
});

describe("an insert cell's advisory", () => {
  const cell = (seg: string, entry: string): InsertCell => ({
    seg,
    anchor: "gone",
    relation: "after",
    by: { file: FILE, entry },
  });
  const noAnchor = (tree: string | null): Miss => ({
    cause: { kind: "no-anchor" },
    tree,
  });

  test("is the same when an earlier cell is deleted and its position in the file's list moves", () => {
    const second = insertNotice(cell("two", "insert.1"), [
      noAnchor("the root"),
    ]);
    const moved = insertNotice(cell("two", "insert.0"), [noAnchor("the root")]);
    expect(moved.message).not.toBe(second.message);
    expect(moved.subject).toEqual(second.subject);
  });

  test("is another for another cell, even one at the same position", () => {
    expect(
      insertNotice(cell("two", "insert.0"), [noAnchor(null)]).subject,
    ).not.toEqual(
      insertNotice(cell("one", "insert.0"), [noAnchor(null)]).subject,
    );
  });

  test("is the same while the cause's words move (the segment holding its id, the trees it missed), and another for another kind of cause", () => {
    const held = (by: string, tree: string) =>
      insertNotice(cell("x", "insert.0"), [
        { cause: { kind: "id-held", held: by }, tree },
      ]);
    expect(held("a", "the root").subject).toEqual(
      held("b", 'preset "p"').subject,
    );
    expect(held("a", "the root").subject).not.toEqual(
      insertNotice(cell("x", "insert.0"), [noAnchor(null)]).subject,
    );
    expect(held("a", "the root").subject).not.toEqual(
      insertNotice(cell("x", "insert.0"), [
        { cause: { kind: "refused", why: "w" }, tree: null },
      ]).subject,
    );
  });
});
