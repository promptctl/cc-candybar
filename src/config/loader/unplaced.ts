// A placement of a segment nothing declares draws nothing: the loader drops
// that one cell and keeps the rest of the bar, and the drop is reported as an
// error beside it (src/config/dsl-loader.ts validateRenderable), unless its
// plugin is absent from the session, which is no error. One unknown name in a
// config must not cost the user every other cell they placed.
//
// [LAW:one-source-of-truth] Which names are dropped, and which of those are
// reported, is one question, answered here for the layout walk (cross-ref.ts),
// the insert cells and the drop alike.

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
import {
  mapOpens,
  placementId,
  walkNodes,
  type InsertCell,
} from "../dsl-types.js";
import {
  ownedBy,
  scopeOf,
  type NamedDefinition,
  type SegmentPresence,
} from "./plugin-scope.js";

// [LAW:single-enforcer] The one place a placed name's presence is decided.
// A name is a plugin's while a namespace that renders here owns it; the scope
// parsed from the name only tells an absent plugin's name from one nothing
// explains.
export function presenceOf(
  segments: Readonly<Record<string, unknown>>,
  rendering: ReadonlyMap<string, NamedDefinition>,
): (name: string) => SegmentPresence {
  const owners = [...rendering].map(
    ([ns, definition]) => [ownedBy(ns), definition] as const,
  );
  return (name) => {
    if (isSettingsAnchor(name) || Object.hasOwn(segments, name))
      return { kind: "declared" };
    const owner = owners.find(([owns]) => owns(name));
    if (owner !== undefined) return { kind: "plugin", definition: owner[1] };
    const scope = scopeOf(name);
    return scope !== undefined && scope !== name
      ? { kind: "absent" }
      : { kind: "missing" };
  };
}

// Whether a placement of a name that does not render is an error: one a
// present plugin does not declare, or one nothing explains.
// [LAW:no-silent-failure] exception: a name under a plugin absent from the
// session is data, like a false `when`, because a home config may place a
// repo's cells for every repo it is used in. A plugin that failed to load is
// not absent: a stand-in declares each of its placed names and draws the drop.
export function reportable(presence: SegmentPresence): boolean {
  return presence.kind === "plugin" || presence.kind === "missing";
}

// Whether a placement id stands on nothing here: every placement under it,
// across the config's root, every preset's root and the insert cells, is of a
// segment whose plugin is absent or is a cell anchored on such a placement,
// at any depth. An anchor names a placement, not a segment, so it is the
// placements it names that are judged; an id naming none is not absent, and
// its cell is reported missing. One id placed under several segments (two
// presets alike) is absent only when all of them are.
export function absentPlacement(
  config: DslConfig,
  cells: readonly InsertCell[],
  presence: (name: string) => SegmentPresence,
): (id: string) => boolean {
  const placed = new Map<string, Array<{ seg: string; anchor?: string }>>();
  const add = (id: string, at: { seg: string; anchor?: string }): void => {
    placed.set(id, [...(placed.get(id) ?? []), at]);
  };
  const trees = (f: RootFragment): readonly LayoutNode[] =>
    isRowsFragment(f) ? Object.values(f.rows) : [f];
  const fragments = [
    config.root,
    ...Object.values(config.presets).flatMap((p) =>
      p.root === undefined ? [] : [p.root],
    ),
  ];
  for (const tree of fragments.flatMap(trees))
    for (const node of walkNodes(tree))
      if (node.kind === "segment") add(placementId(node), { seg: node.name });
  for (const cell of cells)
    add(cell.id ?? cell.seg, { seg: cell.seg, anchor: cell.anchor });
  // [LAW:dataflow-not-control-flow] The least fixpoint over every id, grown
  // until a pass adds none: each pass is linear in the placements, however
  // deep the anchor chains or however often an id is placed. A cycle of
  // anchors places nothing and so never enters the set: its cells stay and
  // are reported missing.
  const absent = new Set<string>();
  const standsOnAbsent = (at: { seg: string; anchor?: string }): boolean =>
    presence(at.seg).kind === "absent" ||
    (at.anchor !== undefined && absent.has(at.anchor));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, at] of placed)
      if (!absent.has(id) && at.every(standsOnAbsent)) {
        absent.add(id);
        grew = true;
      }
  }
  return (id) => absent.has(id);
}

// `config` with every placement of an undeclared segment removed from its
// root and every preset's root, at any depth, disclosure bodies included. A
// tree that was nothing but such a placement becomes an empty row. A config
// with none comes back as itself, so its trees keep their identity.
export function withoutUnplaced(config: DslConfig): DslConfig {
  let removed = 0;
  const declared = presenceOf(config.segments, new Map());
  const placed = (name: string): boolean => {
    const keep = declared(name).kind === "declared";
    if (!keep) removed += 1;
    return keep;
  };
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
  const result = {
    ...config,
    root: root(config.root),
    presets: Object.fromEntries(
      Object.entries(config.presets).map(([name, p]) => [name, preset(p)]),
    ),
  };
  return removed === 0 ? config : result;
}

const EMPTY_ROW: ContainerNode = {
  kind: "container",
  direction: "horizontal",
  children: [],
};
