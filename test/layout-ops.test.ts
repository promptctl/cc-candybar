// [LAW:verifiable-goals] brandon-layout-edit-2gc.1's op vocabulary: the codec
// round-trips every legal op and rejects anything a name with `:`/`/` could
// produce ambiguously. The ops themselves are applied to the authored tree in
// the config file (candybar-config-dqe) — test/json5-edit.test.ts proves
// removeSegmentRef/insertSegmentRef, and test/dsl-layout-edit.test.ts drives
// them through the click.

import {
  decodeLayoutOp,
  encodeLayoutOp,
  type LayoutOp,
} from "../src/config/layout-ops";

describe("layout-ops codec", () => {
  test("round-trips a remove op", () => {
    const op: LayoutOp = { op: "remove", target: "directory" };
    expect(decodeLayoutOp(encodeLayoutOp(op))).toEqual(op);
  });

  test("round-trips an insert op", () => {
    const op: LayoutOp = {
      op: "insert",
      segment: "gitPr",
      anchor: "git",
      relation: "after",
    };
    expect(decodeLayoutOp(encodeLayoutOp(op))).toEqual(op);
  });

  test.each([
    "",
    "remove",
    "remove:",
    "remove:a:b",
    "insert:a:b",
    "insert:a:b:sideways",
    "bogus:a",
  ])("decodeLayoutOp(%j) is null", (token) => {
    expect(decodeLayoutOp(token)).toBeNull();
  });
});
