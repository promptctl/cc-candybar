// [LAW:one-type-per-behavior] The seam brandon-layout-edit-2gc.1 opens: a
// bounded, statically-enumerable vocabulary for editing a layout tree —
// remove the segment named X, insert a named segment before/after an
// existing one. No third LayoutNode kind, no free-form tree editing: a
// segment's own NAME is the stable position (dsl-types.ts already makes it
// one — SegmentNode.name is a ref into `segments`, unaffected by a sibling
// being added or removed elsewhere in the tree), so there is no sibling-index
// to invalidate between the render that offered the click and the click.
//
// [LAW:one-source-of-truth] An op is applied ONCE, to the authored tree in
// the config file (candybar-config-dqe: src/daemon/config-file-store.ts over
// src/config/json5-edit.ts's removeSegmentRef/insertSegmentRef) — the file
// then IS the edited tree, and every reload reads it like any hand-written
// root. This module owns only the op's shape and its wire codec.

import type { LayoutNode } from "./dsl-types.js";

// [LAW:types-are-the-program] The two operations brandon-layout-edit-2gc.1
// ships. Both address position by NAME, never by index. A future op (e.g.
// "move") is a new arm here, not a new node kind or a new codec.
export type LayoutOp =
  | { readonly op: "remove"; readonly target: string }
  | {
      readonly op: "insert";
      readonly segment: string;
      readonly anchor: string;
      readonly relation: "before" | "after";
    };

// [LAW:single-enforcer] THE codec for a LayoutOp crossing the click wire as
// one opaque string. `:` is the delimiter
// (loader/actions.ts's segmentNameSpec rejects `:` and `/` in every name an
// op can carry, so decode is unambiguous — a plain split, no escaping).
// Encode and decode live together so the format cannot drift between the
// validator gate (config-validators.ts, which encodes the ONE token a
// declared action allows), the render side (which emits that same token),
// and the daemon (which decodes it back).
export function encodeLayoutOp(op: LayoutOp): string {
  return op.op === "remove"
    ? `remove:${op.target}`
    : `insert:${op.segment}:${op.anchor}:${op.relation}`;
}

// [LAW:parse-dont-validate] Returns the typed op, or null for anything that
// doesn't decode — the boundary the apply-layout-op verb stamps a wire token
// through before trusting its shape.
export function decodeLayoutOp(token: string): LayoutOp | null {
  const parts = token.split(":");
  if (parts[0] === "remove" && parts.length === 2 && parts[1]) {
    return { op: "remove", target: parts[1] };
  }
  if (
    parts[0] === "insert" &&
    parts.length === 4 &&
    parts[1] &&
    parts[2] &&
    (parts[3] === "before" || parts[3] === "after")
  ) {
    return {
      op: "insert",
      segment: parts[1],
      anchor: parts[2],
      relation: parts[3],
    };
  }
  return null;
}

// [LAW:single-enforcer] THE one collector of "which segment names does this
// tree contain" — brandon-layout-edit-2gc.3's edit-chrome synthesis
// (src/config/edit-chrome.ts) uses it to compute both halves of the +/-
// affordances: which segments are PRESENT (get a `-`) and, by set difference
// against every declared segment, which are ADDABLE (populate the `+`
// picker's domain). A name appearing more than once collapses to one entry —
// callers that care about occurrence COUNT (none currently do) need a
// different walk.
export function collectSegmentNames(root: LayoutNode): ReadonlySet<string> {
  const out = new Set<string>();
  const walk = (node: LayoutNode): void => {
    if (node.kind === "segment") {
      out.add(node.name);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}
