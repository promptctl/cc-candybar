// `insert` cells over one rendered tree: where each lands, and which come
// back unplaced.

import { fragmentNode, insertCells } from "../src/config/root";
import { placeInserts } from "../src/config/presets";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  walkNodes,
  type ContainerNode,
  type DslConfig,
  type InsertCell,
  type LayoutNode,
  type Root,
  type SegmentNode,
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
const by = (i: number) => ({
  file: "/repo/.cc-candybar.json5",
  entry: `insert.${i}`,
});
const cells = (...specs: ReadonlyArray<Omit<InsertCell, "by">>): InsertCell[] =>
  specs.map((spec, i) => ({ ...spec, by: by(i) }));

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
    cells({ seg: "x", anchor: "inner", relation: "after" }),
  );
  expect(unplaced).toEqual([]);
  const row = out.rows.status as ContainerNode;
  const body = (row.children[1] as SegmentNode).opens!.body;
  expect(body.children).toEqual([
    seg("inner"),
    { ...seg("x"), insertedBy: by(0) },
  ]);
});

test("a row that is itself the anchor becomes a row of the two cells", () => {
  const root: Root = { rows: { side: { ...seg("a"), when: "{{ true }}" } } };
  const { root: out } = insertCells(
    root,
    cells({ seg: "x", id: "x2", anchor: "a", relation: "before" }),
  );
  expect(out.rows.side).toEqual({
    ...h({ ...seg("x", "x2"), insertedBy: by(0) }, seg("a")),
    when: "{{ true }}",
  });
});

test("an absent anchor and an id another segment holds both come back unplaced", () => {
  const root: Root = { rows: { status: h(seg("a"), seg("b", "x")) } };
  const { root: out, unplaced } = insertCells(
    root,
    cells(
      { seg: "y", anchor: "nope", relation: "after" },
      { seg: "x", anchor: "a", relation: "after" },
      { seg: "b", id: "x", anchor: "a", relation: "after" },
    ),
  );
  expect(out).toEqual(root);
  expect(unplaced.map((u) => u.cell.by.entry)).toEqual([
    "insert.0",
    "insert.1",
  ]);
  expect(unplaced[1]!.reason).toContain('already segment "b"');
});

test("a cell beside an anchor inside a row hides whenever its anchor's `when` hides it", () => {
  const gated: SegmentNode = { ...seg("a"), when: "{{ .show }}" };
  const root: Root = { rows: { status: h(gated, seg("b")) } };
  const { root: out } = insertCells(
    root,
    cells({ seg: "x", anchor: "a", relation: "after" }),
  );
  expect((out.rows.status as ContainerNode).children).toEqual([
    gated,
    { ...seg("x"), insertedBy: by(0), when: "{{ .show }}" },
    seg("b"),
  ]);
});

test("a cell without an id is satisfied by any placement of its segment, under any id and at any depth", () => {
  const trigger: SegmentNode = {
    ...seg("toggle"),
    opens: {
      ref: { variable: "v", key: "k", member: "open" },
      body: h(seg("x", "deep")),
      placement: "drop",
    },
  };
  const root: Root = { rows: { status: h(seg("a"), trigger) } };
  const { root: out, unplaced } = insertCells(
    root,
    cells({ seg: "x", anchor: "a", relation: "after" }),
  );
  expect(unplaced).toEqual([]);
  expect(out).toBe(root);
});

test("a cell with an id is satisfied by that id alone", () => {
  const root: Root = { rows: { status: h(seg("a"), seg("x", "one")) } };
  const { root: out, unplaced } = insertCells(
    root,
    cells(
      { seg: "x", id: "one", anchor: "a", relation: "after" },
      { seg: "x", id: "two", anchor: "a", relation: "after" },
    ),
  );
  expect(unplaced).toEqual([]);
  expect((out.rows.status as ContainerNode).children).toEqual([
    seg("a"),
    { ...seg("x", "two"), insertedBy: by(1) },
    seg("x", "one"),
  ]);
});

test("a tree no cell lands in comes back as the tree it was given", () => {
  const root: Root = { rows: { status: h(seg("a")) } };
  expect(insertCells(root, []).root).toBe(root);
  expect(
    insertCells(root, cells({ seg: "x", anchor: "nope", relation: "after" }))
      .root,
  ).toBe(root);
});

describe("placeInserts", () => {
  // A preset written as a rows map, one as a whole tree, and the config's
  // own root holding the anchor "a".
  const config: DslConfig = {
    ...DEFAULT_DSL_CONFIG,
    root: { rows: { status: h(seg("a")) } },
    presets: {
      rowsPreset: { root: { rows: { extra: h(seg("b")) } } },
      treePreset: { root: h(seg("b")) },
    },
  };

  const none = { root: false, presets: new Set<string>() };

  test("with no cells, every preset keeps the fragment it was written as", () => {
    const { config: out, notices } = placeInserts(config, [], none);
    expect(out).toBe(config);
    expect(notices).toEqual([]);
  });

  test("with a cell, every preset that restages carries the tree it was judged as, whole", () => {
    const { config: out } = placeInserts(
      config,
      cells({ seg: "x", anchor: "a", relation: "after" }),
      none,
    );
    const names = (preset: string) =>
      [...walkNodes(fragmentNode(out.presets[preset]!.root!))].flatMap((n) =>
        n.kind === "segment" ? [n.name] : [],
      );
    // The rows map renders the root's row, anchor and all, so the cell lands.
    expect(names("rowsPreset")).toEqual(["a", "x", "b"]);
    expect("rows" in out.presets.rowsPreset!.root!).toBe(false);
    // The whole tree holds no "a": it carries its own tree, without the cell.
    expect(names("treePreset")).toEqual(["b"]);
  });

  test("a missed anchor warns for the root only when a config file writes it", () => {
    const missing = cells({ seg: "x", anchor: "nope", relation: "after" });
    expect(placeInserts(config, missing, none).notices).toEqual([]);
    expect(
      placeInserts(config, missing, { ...none, root: true }).notices,
    ).toEqual([
      '/repo/.cc-candybar.json5: insert.0 places "x" after "nope", but there is no placement "nope" (in the root)',
    ]);
  });
});
