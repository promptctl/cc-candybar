// [LAW:decomposition] The root as a MERGEABLE map of named rows — the algebra
// between the authoring shapes (a whole tree or a `{ rows }` map, see
// RootFragment) and the tree the render walk consumes (`rootNode`). Every
// consumer that merges, projects, or addresses a root by row goes through
// this module; nothing else knows how positional rows are named.
//
// [LAW:one-type-per-behavior] `mergeRoot` is the ONE fold for both places a
// fragment lands: a file's `root` over the bundled default's (loader/merge.ts)
// and a preset's `root` over the config's own (presets.ts). "A preset that
// declares no root stages the config's own" is not an arm here — the absent
// fragment IS the empty rows map, the merge's identity, so the two callers and
// the floor preset all run the same expression [LAW:dataflow-not-control-flow].

import {
  placementId,
  walkNodePaths,
  walkNodes,
  type ContainerNode,
  type InsertCell,
  type LayoutNode,
  type SegmentNode,
  type Root,
  type RootFragment,
} from "./dsl-types.js";

// [LAW:types-are-the-program] A row name must be an identifier: it is spliced
// into config-file paths (`root.rows.<name>`) by the edit-mode write-back and
// must never be integer-like, because a JS object orders integer-like keys
// numerically ahead of every other key, which would silently reorder a rows
// map under the by-name spread. Shared with group names for the same reason
// they share the constraint (both splice into addresses).
export const ROW_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// [LAW:one-source-of-truth] The name a whole tree's i-th row lowers to. `#`
// fails ROW_NAME_RE, so a positional row can never collide with — or be
// shadowed by — an authored one, and is never integer-like.
export function positionalRowName(index: number): string {
  return `#${index + 1}`;
}

// The merge's identity: restages nothing.
export const EMPTY_ROWS: Root = { rows: {} };

// [LAW:parse-dont-validate] The discriminator of a fragment's two intents,
// read from the shape the author wrote. A canonical LayoutNode always carries
// `kind`; a Root never does.
export function isRowsFragment(fragment: RootFragment): fragment is Root {
  return "rows" in fragment;
}

function positionalRows(rows: readonly LayoutNode[]): Root["rows"] {
  return Object.fromEntries(rows.map((row, i) => [positionalRowName(i), row]));
}

// [LAW:one-source-of-truth] Lower a whole tree to rows. A vertical container's
// children ARE its rows and everything else it owns (`when`, `distribution`,
// …) IS the root's own — the root is that container, so its own fields cross
// as one rest-spread, never a hand-picked field. Any other node is the bar's
// single row, its own `when` lifted to the root (a gate on the only row is a
// gate on the bar) while the rest — a horizontal row's `distribution` places
// THAT row's cells — stays on the row. Total, and `rootNode` inverts it
// exactly for a vertical tree — a spliced tree round-trips byte-identical
// through synthesis — while a single-row tree gains only the vertical wrapper
// every root has anyway.
export function rootOf(node: LayoutNode): Root {
  if (node.kind === "container" && node.direction === "vertical") {
    const { kind, direction, children, ...own } = node;
    return { ...own, rows: positionalRows(children) };
  }
  const { when, ...rest } = node;
  return {
    ...(when !== undefined && { when }),
    rows: positionalRows([rest as LayoutNode]),
  };
}

// [LAW:one-source-of-truth] THE projection from the canonical root to the
// tree every walk consumes: the rows stacked vertically, carrying the root's
// own fields verbatim. Always a container, so no consumer wraps a bare-segment
// root itself.
export function rootNode(root: Root): ContainerNode {
  const { rows, ...own } = root;
  return {
    kind: "container",
    direction: "vertical",
    children: Object.values(rows),
    ...own,
  };
}

// The tree a fragment authors on its own — a whole tree as written, a rows
// map as the rows it names — for the checks that inspect what an author
// wrote rather than what renders.
export function fragmentNode(fragment: RootFragment): LayoutNode {
  return isRowsFragment(fragment) ? rootNode(fragment) : fragment;
}

// [LAW:one-source-of-truth] Every node of an AUTHORED fragment beside the
// path its author would look for it at — for the checks that report against
// what a file wrote rather than what renders (cross-ref's per-layout walk). A
// whole tree is walked as written; a rows map yields the root's own fields at
// `key` and each row at `<key>.rows.<name>`. Only a file's own fragment has
// these addresses: a merged root has lowered a whole tree to positional rows,
// whose index is no longer where anything was written.
export function* fragmentNodePaths(
  fragment: RootFragment,
  key: string,
): IterableIterator<readonly [LayoutNode, string]> {
  if (!isRowsFragment(fragment)) {
    yield* walkNodePaths(fragment, key);
    return;
  }
  yield [rootNode(fragment), key];
  for (const [name, row] of Object.entries(fragment.rows)) {
    yield* walkNodePaths(row, `${key}.rows.${name}`);
  }
}

// [LAW:one-type-per-behavior] THE cascade for a root, the same shape as every
// other by-name section: a rows fragment merges per name over the base
// (inherit in place, replace by name, append new; `when` per field like a
// globals field), and a whole tree replaces the base's rows outright. The one
// branch is over the fragment's own two intents, which is the entire point of
// RootFragment's union.
export function mergeRoot(fragment: RootFragment, base: Root): Root {
  return isRowsFragment(fragment)
    ? { ...base, ...fragment, rows: { ...base.rows, ...fragment.rows } }
    : rootOf(fragment);
}

// A cell a layer's `insert` list could not place, and why — the layer's
// loader turns each into a warning naming its file.
export interface Unplaced {
  readonly entry: string;
  readonly seg: string;
  readonly reason: string;
}

// [LAW:one-source-of-truth] THE placement of a layer's `insert` cells, folded
// over the root that layer's own `root` merged into, in list order (a later
// cell may anchor on an earlier one). A cell lands beside the placement its
// anchor names, wherever in the tree that is, so a whole-tree root and a rows
// map are addressed alike. A cell whose id the tree already holds under the
// same segment is satisfied as it stands; under another segment it would make
// the id ambiguous, so it is refused like a missing anchor.
// [LAW:no-silent-failure] Every cell that does not land comes back unplaced.
export function insertCells(
  root: Root,
  cells: readonly InsertCell[],
  file: string,
): { readonly root: Root; readonly unplaced: readonly Unplaced[] } {
  return cells.reduce<{ root: Root; unplaced: readonly Unplaced[] }>(
    (acc, cell, i) => {
      const entry = `insert[${i}]`;
      const id = cell.id ?? cell.seg;
      const held = segmentWithId(rootNode(acc.root), id);
      if (held !== undefined) {
        return held.name === cell.seg
          ? acc
          : refuse(
              acc,
              entry,
              cell,
              `as "${id}", but placement "${id}" is already segment "${held.name}" — give the cell its own id`,
            );
      }
      const node: SegmentNode = {
        kind: "segment",
        name: cell.seg,
        ...(cell.id !== undefined && { id: cell.id }),
        insertedBy: { file, entry },
      };
      const rows = Object.entries(acc.root.rows);
      const placed = rows.map(
        ([name, row]) =>
          [name, besideRow(row, cell.anchor, node, cell.relation)] as const,
      );
      return placed.some(([, row]) => row !== null)
        ? {
            ...acc,
            root: {
              ...acc.root,
              rows: Object.fromEntries(
                placed.map(([name, row], r) => [name, row ?? rows[r]![1]]),
              ),
            },
          }
        : refuse(
            acc,
            entry,
            cell,
            `${cell.relation} "${cell.anchor}", but the bar has no placement "${cell.anchor}"`,
          );
    },
    { root, unplaced: [] },
  );
}

function refuse(
  acc: { root: Root; unplaced: readonly Unplaced[] },
  entry: string,
  cell: InsertCell,
  reason: string,
): { root: Root; unplaced: readonly Unplaced[] } {
  return {
    ...acc,
    unplaced: [...acc.unplaced, { entry, seg: cell.seg, reason }],
  };
}

function segmentWithId(tree: LayoutNode, id: string): SegmentNode | undefined {
  for (const node of walkNodes(tree)) {
    if (node.kind === "segment" && placementId(node) === id) return node;
  }
  return undefined;
}

// A row that IS the anchor becomes a horizontal row of the two cells; any
// other row places the cell inside it. null: the anchor is not in this row.
function besideRow(
  row: LayoutNode,
  anchor: string,
  cell: SegmentNode,
  relation: "before" | "after",
): LayoutNode | null {
  if (row.kind === "segment" && placementId(row) === anchor) {
    const { when, ...rest } = row;
    return {
      kind: "container",
      direction: "horizontal",
      children: relation === "before" ? [cell, rest] : [rest, cell],
      ...(when !== undefined && { when }),
    };
  }
  return beside(row, anchor, cell, relation);
}

// The node with `cell` spliced beside the anchor among its siblings, or null
// when no sibling list under `node` holds the anchor. Disclosure bodies are
// searched like containers.
function beside(
  node: LayoutNode,
  anchor: string,
  cell: SegmentNode,
  relation: "before" | "after",
): LayoutNode | null {
  if (node.kind === "segment") {
    if (node.opens === undefined) return null;
    const body = beside(node.opens.body, anchor, cell, relation);
    return body === null
      ? null
      : { ...node, opens: { ...node.opens, body: body as ContainerNode } };
  }
  const at = node.children.findIndex(
    (child) => child.kind === "segment" && placementId(child) === anchor,
  );
  if (at >= 0) {
    const cut = relation === "before" ? at : at + 1;
    return {
      ...node,
      children: [
        ...node.children.slice(0, cut),
        cell,
        ...node.children.slice(cut),
      ],
    };
  }
  for (const [i, child] of node.children.entries()) {
    const next = beside(child, anchor, cell, relation);
    if (next !== null) {
      return {
        ...node,
        children: node.children.map((c, j) => (j === i ? next : c)),
      };
    }
  }
  return null;
}

// Whether a fragment restages anything at all — false exactly for the merge's
// identity (an absent or empty rows map carrying no own field), which is when
// a preset renders the config's own root untouched and its layout is authored
// at `root`. Any own field alone restages: a `when` gates the whole bar, a
// `distribution` re-places its rows. json5-edit's `restagesFragment` is this
// predicate read off the document; change them together.
export function restages(fragment: RootFragment): boolean {
  if (!isRowsFragment(fragment)) return true;
  const { rows, ...own } = fragment;
  return (
    Object.values(own).some((v) => v !== undefined) ||
    Object.keys(rows).length > 0
  );
}
