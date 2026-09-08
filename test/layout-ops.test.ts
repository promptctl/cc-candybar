// [LAW:verifiable-goals] Round-trips every legal op; rejects what a `:`/`/` name makes ambiguous.

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
