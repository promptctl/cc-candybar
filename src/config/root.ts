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

import type {
  ContainerNode,
  LayoutNode,
  Root,
  RootFragment,
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
// wrote rather than what renders (cross-ref's per-layout walk).
export function fragmentNode(fragment: RootFragment): LayoutNode {
  return isRowsFragment(fragment) ? rootNode(fragment) : fragment;
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

// Whether a fragment restages anything at all — false exactly for the merge's
// identity (an absent or empty rows map carrying no own field), which is when
// a preset renders the config's own root untouched and its layout is authored
// at `root`. Any own field alone restages: a `when` gates the whole bar, a
// `distribution` re-places its rows.
export function restages(fragment: RootFragment): boolean {
  if (!isRowsFragment(fragment)) return true;
  const { rows, ...own } = fragment;
  return (
    Object.values(own).some((v) => v !== undefined) ||
    Object.keys(rows).length > 0
  );
}
