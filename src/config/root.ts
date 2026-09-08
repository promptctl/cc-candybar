// [LAW:decomposition] The root as a MERGEABLE map of named rows; nothing else knows how positional rows are named.
// [LAW:one-type-per-behavior] `mergeRoot` is the ONE fold for both places a fragment lands. [LAW:dataflow-not-control-flow] An absent fragment IS the empty rows map, the merge's identity — not an arm.

import type {
  ContainerNode,
  LayoutNode,
  Root,
  RootFragment,
} from "./dsl-types.js";

// [LAW:types-are-the-program] Spliced into config-file paths, and never integer-like: JS orders integer-like keys first, silently reordering a rows map under the by-name spread.
export const ROW_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// [LAW:one-source-of-truth] `#` fails ROW_NAME_RE, so a positional row can never collide with an authored one.
export function positionalRowName(index: number): string {
  return `#${index + 1}`;
}

export const EMPTY_ROWS: Root = { rows: {} };

// [LAW:parse-dont-validate] A canonical LayoutNode always carries `kind`; a Root never does.
export function isRowsFragment(fragment: RootFragment): fragment is Root {
  return "rows" in fragment;
}

function positionalRows(rows: readonly LayoutNode[]): Root["rows"] {
  return Object.fromEntries(rows.map((row, i) => [positionalRowName(i), row]));
}

// [LAW:one-source-of-truth] A vertical container's children ARE its rows and its own fields the root's, so they cross as one rest-spread;
// any other node is the single row with its `when` lifted (a gate on the only row gates the bar). `rootNode` inverts this.
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

// [LAW:one-source-of-truth] THE projection every walk consumes; always a container, so no consumer wraps a bare-segment root.
export function rootNode(root: Root): ContainerNode {
  const { rows, ...own } = root;
  return {
    kind: "container",
    direction: "vertical",
    children: Object.values(rows),
    ...own,
  };
}

export function fragmentNode(fragment: RootFragment): LayoutNode {
  return isRowsFragment(fragment) ? rootNode(fragment) : fragment;
}

// [LAW:one-type-per-behavior] A rows fragment merges per name, a whole tree replaces outright — one branch, over the fragment's own two intents.
export function mergeRoot(fragment: RootFragment, base: Root): Root {
  return isRowsFragment(fragment)
    ? { ...base, ...fragment, rows: { ...base.rows, ...fragment.rows } }
    : rootOf(fragment);
}

// False exactly for the merge's identity; any own field alone restages. json5-edit's `restagesFragment` is this predicate read off the document — change them together.
export function restages(fragment: RootFragment): boolean {
  if (!isRowsFragment(fragment)) return true;
  const { rows, ...own } = fragment;
  return (
    Object.values(own).some((v) => v !== undefined) ||
    Object.keys(rows).length > 0
  );
}
