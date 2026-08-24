// [LAW:one-type-per-behavior] The seam brandon-layout-edit-2gc.1 opens: a
// bounded, statically-enumerable vocabulary for mutating a LayoutNode tree —
// remove the segment named X, insert a named segment before/after an
// existing one. No third LayoutNode kind, no free-form tree editing: a
// segment's own NAME is the stable position (dsl-types.ts already makes it
// one — SegmentNode.name is a ref into `segments`, unaffected by a sibling
// being added or removed elsewhere in the tree), so there is no sibling-index
// to invalidate when a prior op lands.
//
// [LAW:no-ambient-temporal-coupling] A position is never a fact frozen at
// declaration or click time — `removeSegment`/`insertSegment` always walk
// the CURRENT tree handed to them. The daemon (src/daemon/cache/render.ts)
// replays the accumulated op log against the live merged config on every
// reload, so a later, unrelated config edit is what the next replay sees,
// never a stale snapshot.
//
// [LAW:no-silent-failure] exception: a target/anchor absent from the tree is
// a documented NO-OP, not a thrown error — mirroring
// src/config/loader/merge.ts's applySegmentPaletteOverrides, the identical
// failure shape one layer up. A validated action can only ever name a
// segment the config declares (loader/cross-ref.ts checks this at config
// load), so a miss here only happens after a LATER edit (to the bundled
// default, the user's config, or an earlier op in the same accumulated list)
// removed the segment — there is nothing left to apply the op to, and
// bricking the whole render over a stale op would be worse than dropping it.

import type { LayoutNode, SegmentNode } from "./dsl-types.js";

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

// [LAW:single-enforcer] THE codec for a LayoutOp crossing the click wire and
// the config-overrides file as one opaque string. `:` is the delimiter
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
// doesn't decode — the boundary a caller stamps before trusting the shape.
// Reached only from data this process did not itself just encode (a
// hand-edited or previous-version config-overrides.json), never from a
// value produced by encodeLayoutOp in the same click.
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

// [LAW:dataflow-not-control-flow] Ops are DATA folded over the tree in
// order — replaying zero ops is the identity fold, replaying N is the same
// reduce for every N. No branch on "are there ops to apply."
export function applyLayoutOps(
  root: LayoutNode,
  ops: readonly LayoutOp[],
): LayoutNode {
  return ops.reduce(applyOne, root);
}

function applyOne(root: LayoutNode, op: LayoutOp): LayoutNode {
  return op.op === "remove"
    ? removeSegment(root, op.target)
    : insertSegment(root, op.segment, op.anchor, op.relation);
}

// [LAW:types-are-the-program] Total and non-throwing: every LayoutNode maps
// to a LayoutNode, whether or not `target` is present. Acts on the FIRST
// segment found named `target`, in walkNodes' canonical pre-order — a
// deterministic, documented tie-break for the edge case of a duplicate name,
// never an ambiguous or thrown outcome. `done` is a closure-local flag (fresh
// per call, never shared across calls) that stops the search the instant a
// match is spliced out, so an EARLIER sibling's match always wins over a
// LATER one — exactly walkNodes' visit order, not merely "this container's
// own children before its descendants" (a subtly different, wrong order a
// single-pass children-array scan would produce). An absent target returns
// the identical root reference.
function removeSegment(root: LayoutNode, target: string): LayoutNode {
  let done = false;
  function walk(node: LayoutNode): LayoutNode {
    if (done || node.kind === "segment") return node;
    const children: LayoutNode[] = [];
    for (const child of node.children) {
      if (!done && child.kind === "segment" && child.name === target) {
        done = true;
        continue;
      }
      children.push(walk(child));
    }
    return { ...node, children };
  }
  const result = walk(root);
  return done ? result : root;
}

// [LAW:types-are-the-program] Splices a new `{ kind: "segment", name:
// segment }` node immediately before/after the FIRST node found named
// `anchor`, in walkNodes' canonical pre-order (see removeSegment's `done`
// note — the same closure-local stop-at-first-match shape). Total and
// non-throwing: an absent anchor returns the identical root reference.
function insertSegment(
  root: LayoutNode,
  segment: string,
  anchor: string,
  relation: "before" | "after",
): LayoutNode {
  let done = false;
  function walk(node: LayoutNode): LayoutNode {
    if (done || node.kind === "segment") return node;
    const children: LayoutNode[] = [];
    for (const child of node.children) {
      if (!done && child.kind === "segment" && child.name === anchor) {
        done = true;
        const inserted: SegmentNode = { kind: "segment", name: segment };
        if (relation === "before") children.push(inserted, child);
        else children.push(child, inserted);
        continue;
      }
      children.push(walk(child));
    }
    return { ...node, children };
  }
  const result = walk(root);
  return done ? result : root;
}
