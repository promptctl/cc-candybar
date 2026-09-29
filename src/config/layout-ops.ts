// [LAW:one-type-per-behavior] The seam brandon-layout-edit-2gc.1 opens: a
// bounded, statically-enumerable vocabulary for editing a layout tree —
// remove the placement with id X, insert a segment before/after an existing
// placement. No third LayoutNode kind, no free-form tree editing: a
// placement's ID is the stable position (brandon-segment-settings-i4n —
// `placementId`, unaffected by a sibling being added or removed elsewhere in
// the tree), so there is no sibling-index to invalidate between the render
// that offered the click and the click.
//
// [LAW:one-source-of-truth] An op is applied ONCE, to the authored tree in
// the config file (candybar-config-dqe: src/daemon/config-file-store.ts over
// src/config/json5-edit.ts's removeSegmentRef/insertSegmentRef) — the file
// then IS the edited tree, and every reload reads it like any hand-written
// root. This module owns only the op's shape, its wire codec, and the id an
// insertion mints.

import { freePlacementId, placementIds, type LayoutNode } from "./dsl-types.js";

// [LAW:types-are-the-program] The two operations brandon-layout-edit-2gc.1
// ships. Both address position by placement ID, never by index: `target` and
// `anchor` are ids, `segment` is the segment an insertion places. A future op
// (e.g. "move") is a new arm here, not a new node kind or a new codec.
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

// What an insertion writes into the layout: the bare segment name — whose id
// is that name — while no placement already holds it, else the segment under
// the first free `<name>-<n>`, n from 2. Ids are unique per tree
// (cross-ref.ts), so the insertion must never mint one already taken.
export type NewPlacement =
  | { readonly seg: string }
  | { readonly seg: string; readonly id: string };

// [LAW:single-enforcer] THE id an insertion mints, free in every tree the
// insertion reaches. The layer it writes (`root.rows.<row>`, a shared
// fragment) can reach presets other than the one clicked — and the new
// placement lands beside `anchor`, so the trees it reaches are exactly the
// trees that hold `anchor`.
export function mintPlacement(
  segment: string,
  anchor: string,
  trees: readonly LayoutNode[],
): NewPlacement {
  const taken = new Set(
    trees
      .map(placementIds)
      .filter((held) => held.includes(anchor))
      .flat(),
  );
  const id = freePlacementId(segment, taken);
  return id === segment ? { seg: segment } : { seg: segment, id };
}
