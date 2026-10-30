// A layer's `insert` cells over a merged root: where each lands, and which
// come back unplaced.

import { insertCells } from "../src/config/root";
import type {
  ContainerNode,
  LayoutNode,
  Root,
  SegmentNode,
} from "../src/config/dsl-types";

const seg = (name: string, id?: string): SegmentNode => ({
  kind: "segment",
  name,
  ...(id !== undefined && { id }),
});
const h = (...children: LayoutNode[]): ContainerNode => ({
  kind: "container",
  direction: "horizontal",
  children,
});
const by = (entry: string) => ({ file: "/repo/.cc-candybar.json5", entry });
const FILE = "/repo/.cc-candybar.json5";

test("a cell lands inside a disclosure body that holds its anchor", () => {
  const trigger: SegmentNode = {
    ...seg("toggle"),
    opens: {
      ref: { variable: "v", key: "k", member: "open" },
      body: h(seg("inner")),
      placement: "drop",
    },
  };
  const root: Root = { rows: { status: h(seg("a"), trigger) } };
  const { root: out, unplaced } = insertCells(
    root,
    [{ seg: "x", anchor: "inner", relation: "after" }],
    FILE,
  );
  expect(unplaced).toEqual([]);
  const row = out.rows.status as ContainerNode;
  const body = (row.children[1] as SegmentNode).opens!.body;
  expect(body.children).toEqual([
    seg("inner"),
    { ...seg("x"), insertedBy: by("insert[0]") },
  ]);
});

test("a row that is itself the anchor becomes a row of the two cells", () => {
  const root: Root = { rows: { side: { ...seg("a"), when: "{{ true }}" } } };
  const { root: out } = insertCells(
    root,
    [{ seg: "x", id: "x2", anchor: "a", relation: "before" }],
    FILE,
  );
  expect(out.rows.side).toEqual({
    ...h({ ...seg("x", "x2"), insertedBy: by("insert[0]") }, seg("a")),
    when: "{{ true }}",
  });
});

test("an absent anchor and an id another segment holds both come back unplaced", () => {
  const root: Root = { rows: { status: h(seg("a"), seg("b", "x")) } };
  const { root: out, unplaced } = insertCells(
    root,
    [
      { seg: "y", anchor: "nope", relation: "after" },
      { seg: "x", anchor: "a", relation: "after" },
      { seg: "b", id: "x", anchor: "a", relation: "after" },
    ],
    FILE,
  );
  expect(out).toEqual(root);
  expect(unplaced.map((u) => u.entry)).toEqual(["insert[0]", "insert[1]"]);
  expect(unplaced[1]!.reason).toContain('already segment "b"');
});
