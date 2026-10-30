// A placement of a segment nothing declares draws nothing: the loader drops
// that one cell and keeps the rest of the bar, and the drop is reported as an
// error beside it (src/config/dsl-loader.ts validateRenderable). One unknown
// name in a config must not cost the user every other cell they placed.
//
// [LAW:one-source-of-truth] Which names are dropped is the same question the
// layout walk's "does not match any declared segment" asks
// (cross-ref.ts): declared in `segments`, or the settings menu's anchor.

import { isRowsFragment } from "../root.js";
import { isSettingsAnchor } from "../settings-menu.js";
import type {
  ContainerNode,
  DslConfig,
  LayoutNode,
  PresetDecl,
  Root,
  RootFragment,
} from "../dsl-types.js";
import { mapOpens } from "../dsl-types.js";

// `config` with every placement of an undeclared segment removed from its
// root and every preset's root, at any depth, disclosure bodies included. A
// tree that was nothing but such a placement becomes an empty row.
export function withoutUnplaced(config: DslConfig): DslConfig {
  const placed = (name: string): boolean =>
    isSettingsAnchor(name) ||
    Object.prototype.hasOwnProperty.call(config.segments, name);
  const container = (node: ContainerNode): ContainerNode => ({
    ...node,
    children: node.children.flatMap((child) => nodes(child)),
  });
  const nodes = (node: LayoutNode): LayoutNode[] =>
    node.kind === "container"
      ? [container(node)]
      : placed(node.name)
        ? [mapOpens(node, container)]
        : [];
  const tree = (node: LayoutNode): LayoutNode => nodes(node)[0] ?? EMPTY_ROW;
  const root = (r: Root): Root => ({
    ...r,
    rows: Object.fromEntries(
      Object.entries(r.rows).map(([name, row]) => [name, tree(row)]),
    ),
  });
  const fragment = (f: RootFragment): RootFragment =>
    isRowsFragment(f) ? root(f) : tree(f);
  const preset = (p: PresetDecl): PresetDecl =>
    p.root === undefined ? p : { ...p, root: fragment(p.root) };
  return {
    ...config,
    root: root(config.root),
    presets: Object.fromEntries(
      Object.entries(config.presets).map(([name, p]) => [name, preset(p)]),
    ),
  };
}

const EMPTY_ROW: ContainerNode = {
  kind: "container",
  direction: "horizontal",
  children: [],
};
