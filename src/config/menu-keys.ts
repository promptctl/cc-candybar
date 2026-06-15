// [LAW:one-source-of-truth] THE derivation of a menu's accordion identity from
// layout structure — the single place both the loader (which SYNTHESIZES the
// state var + cycle action) and the renderer (which READS openness + emits the
// toggle) agree on "which key holds which open menu". A `{{ menu }}` helper is
// context-free (it cannot see its own tree position), so its row key and member
// name are NOT in the helper string — they are derived here from where its host
// segment sits, and the two consumers MUST derive identical strings or a click
// would write a key the render never reads. Keeping the rule in one module makes
// that agreement structural rather than a coincidence of two copies.
//
// [LAW:decomposition] "The row IS the key": menus mutually exclude exactly when
// they share an enclosing horizontal container — so the row key is that
// container's structural path, and a menu outside any horizontal container gets
// its own path as a singleton key (it can only toggle itself). The member name a
// row key holds is the host segment's name.

import type { LayoutNode } from "./dsl-types.js";

// [LAW:one-source-of-truth] The reserved namespace every synthesized menu
// artifact (state var + cycle action) lives under, mirroring group sugar's
// `groups.`. A user-authored name under this prefix is a load error so synthesis
// can never silently collide.
export const MENU_NS = "menus.";

// The "no menu open" sentinel a row key starts from and returns to on close.
// A menu's member name is its host segment name; segment names cannot equal this
// (a row holding "closed" means every menu in it is shut).
export const MENU_CLOSED = "closed";

// [LAW:representation] Disclosure glyph vocabulary — identical to group sugar so
// every disclosure across the bar reads the same (trailing the label/content it
// gates, per pdu.8): collapsed ▸, expanded ▾.
export const MENU_GLYPH_CLOSED = "▸";
export const MENU_GLYPH_OPEN = "▾";

// [LAW:types-are-the-program] A row key is a structural path (e.g.
// `root.children[1]`); collapse it to an identifier-shaped id so the synthesized
// var/action/SessionState-key names carry no dots or brackets. Distinct tree
// paths never collide under this map (sibling indices stay distinct: `[1]` vs
// `[11]` → `_1_` vs `_11_`).
function menuRowId(rowKey: string): string {
  return rowKey.replace(/[^A-Za-z0-9]+/g, "_");
}

// The SessionState key (and the state-var name reading it) for one row's open
// menu. One key per row holds at most one open member name → accordion.
export function menuStateKey(rowKey: string): string {
  return MENU_NS + menuRowId(rowKey);
}

// The synthesized cycle action a menu's disclosure toggle realizes: writing this
// row key between MENU_CLOSED and the host segment's name. Named per (row,
// segment) so two menus sharing a row contribute two cycles on one key — the
// existing same-key validator merge unions their members into the gate.
export function menuActionName(rowKey: string, segName: string): string {
  return MENU_NS + menuRowId(rowKey) + "." + segName;
}

// [LAW:single-enforcer] THE rule for a segment placement's row key: the nearest
// enclosing horizontal container's path, or the segment's own path when none.
// Both the loader walk and the compile walk call this with the values they
// already track, so neither restates the rule.
export function rowKeyFor(
  nearestHorizontalPath: string | undefined,
  ownPath: string,
): string {
  return nearestHorizontalPath ?? ownPath;
}

// [LAW:single-enforcer] THE one walk that assigns every segment placement its
// path and row key. The path format (`root` + `.children[i]`) MUST match the
// compile walk's (`registerDslConfig`'s `compileNode`), since the row key a click
// targets is keyed by that path; this is the load-side mirror of that walk, so
// the two produce identical paths over the same tree. `visit` receives the
// segment name, its row key, and its own path (in case a consumer needs to map
// by exact placement).
export function forEachSegmentPlacement(
  root: LayoutNode,
  visit: (segName: string, rowKey: string, ownPath: string) => void,
): void {
  const recur = (
    node: LayoutNode,
    path: string,
    nearestHorizontalPath: string | undefined,
  ): void => {
    if (node.kind === "segment") {
      visit(node.name, rowKeyFor(nearestHorizontalPath, path), path);
      return;
    }
    // [LAW:dataflow-not-control-flow] A horizontal container REPLACES the nearest-
    // horizontal path for its subtree; any other container PASSES it through. The
    // direction is a value selecting which path the children inherit, not a branch
    // that skips the recursion.
    const childNearestHorizontal =
      node.direction === "horizontal" ? path : nearestHorizontalPath;
    node.children.forEach((child, i) =>
      recur(child, `${path}.children[${i}]`, childNearestHorizontal),
    );
  };
  recur(root, "root", undefined);
}
