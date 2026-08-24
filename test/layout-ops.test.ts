// [LAW:verifiable-goals] brandon-layout-edit-2gc.1's pure tree-transform layer:
// remove/insert address position by segment NAME, never by sibling index, so
// they must stay correct as earlier ops in a sequence shift the tree under
// them; a stale target/anchor is a documented no-op, never a throw; the codec
// round-trips every legal op and rejects anything a name with `:`/`/` could
// produce ambiguously.

import {
  applyLayoutOps,
  decodeLayoutOp,
  encodeLayoutOp,
  type LayoutOp,
} from "../src/config/layout-ops";
import type {
  ContainerNode,
  LayoutNode,
  SegmentNode,
} from "../src/config/dsl-types";

function seg(name: string): SegmentNode {
  return { kind: "segment", name };
}
function h(...children: LayoutNode[]): ContainerNode {
  return { kind: "container", direction: "horizontal", children };
}
function v(...children: LayoutNode[]): ContainerNode {
  return { kind: "container", direction: "vertical", children };
}
function names(node: LayoutNode): string[] {
  if (node.kind === "segment") return [node.name];
  return node.children.flatMap(names);
}

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

describe("applyLayoutOps: remove", () => {
  test("removes a top-level segment, preserving sibling order", () => {
    const root = h(seg("directory"), seg("git"), seg("model"));
    const next = applyLayoutOps(root, [{ op: "remove", target: "git" }]);
    expect(names(next)).toEqual(["directory", "model"]);
  });

  test("removes a nested segment", () => {
    const root = v(
      h(seg("directory"), seg("git")),
      h(seg("model"), seg("context")),
    );
    const next = applyLayoutOps(root, [{ op: "remove", target: "model" }]);
    expect(names(next)).toEqual(["directory", "git", "context"]);
  });

  test("a missing target is a no-op returning the identical reference", () => {
    const root = h(seg("directory"), seg("git"));
    const next = applyLayoutOps(root, [{ op: "remove", target: "nope" }]);
    expect(next).toBe(root);
  });

  test("removes only the FIRST occurrence in pre-order, for a duplicate name", () => {
    // v[ h[dup], h[other, dup] ] — pre-order visits the first `dup` (inside
    // h1) before the second (inside h2).
    const root = v(h(seg("dup")), h(seg("other"), seg("dup")));
    const next = applyLayoutOps(root, [{ op: "remove", target: "dup" }]);
    expect(names(next)).toEqual(["other", "dup"]);
  });
});

describe("applyLayoutOps: insert", () => {
  test("inserts before an anchor", () => {
    const root = h(seg("directory"), seg("git"));
    const next = applyLayoutOps(root, [
      { op: "insert", segment: "context", anchor: "git", relation: "before" },
    ]);
    expect(names(next)).toEqual(["directory", "context", "git"]);
  });

  test("inserts after an anchor", () => {
    const root = h(seg("directory"), seg("git"));
    const next = applyLayoutOps(root, [
      { op: "insert", segment: "gitPr", anchor: "git", relation: "after" },
    ]);
    expect(names(next)).toEqual(["directory", "git", "gitPr"]);
  });

  test("inserts into a nested container", () => {
    const root = v(h(seg("directory"), seg("git")), h(seg("model")));
    const next = applyLayoutOps(root, [
      { op: "insert", segment: "context", anchor: "model", relation: "after" },
    ]);
    expect(names(next)).toEqual(["directory", "git", "model", "context"]);
  });

  test("a missing anchor is a no-op returning the identical reference", () => {
    const root = h(seg("directory"), seg("git"));
    const next = applyLayoutOps(root, [
      { op: "insert", segment: "gitPr", anchor: "nope", relation: "after" },
    ]);
    expect(next).toBe(root);
  });
});

describe("applyLayoutOps: composition", () => {
  // [LAW:verifiable-goals] The core promise a click-driven op log depends
  // on: a SEQUENCE of ops composes onto the tree left of it, never clobbering
  // an earlier op — the whole reason this ships as a replayed log instead of
  // a precomputed literal tree.
  test("a remove then an insert both land, applied in order", () => {
    const root = h(seg("directory"), seg("git"), seg("model"));
    const next = applyLayoutOps(root, [
      { op: "remove", target: "git" },
      { op: "insert", segment: "gitPr", anchor: "model", relation: "before" },
    ]);
    expect(names(next)).toEqual(["directory", "gitPr", "model"]);
  });

  test("an insert whose anchor a PRIOR op already removed is a no-op for that op only", () => {
    const root = h(seg("directory"), seg("git"), seg("model"));
    const next = applyLayoutOps(root, [
      { op: "remove", target: "git" },
      // "git" no longer exists — this op is dropped, not thrown.
      { op: "insert", segment: "gitPr", anchor: "git", relation: "after" },
      { op: "insert", segment: "context", anchor: "model", relation: "after" },
    ]);
    expect(names(next)).toEqual(["directory", "model", "context"]);
  });

  test("an empty op list is the identity", () => {
    const root = h(seg("directory"), seg("git"));
    expect(applyLayoutOps(root, [])).toBe(root);
  });
});
