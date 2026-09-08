// [LAW:one-type-per-behavior] A bounded vocabulary for editing a layout tree. A segment's
// NAME is the position, so no sibling index can go stale between the render and the click.
// [LAW:one-source-of-truth] An op is applied ONCE, to the authored tree in the config file.

import { walkNodes, type LayoutNode } from "./dsl-types.js";

// [LAW:types-are-the-program] Position by NAME, never index; a future op is a new arm here.
export type LayoutOp =
  | { readonly op: "remove"; readonly target: string }
  | {
      readonly op: "insert";
      readonly segment: string;
      readonly anchor: string;
      readonly relation: "before" | "after";
    };

// [LAW:single-enforcer] THE codec: encode and decode live together so the format cannot drift.
export function encodeLayoutOp(op: LayoutOp): string {
  return op.op === "remove"
    ? `remove:${op.target}`
    : `insert:${op.segment}:${op.anchor}:${op.relation}`;
}

// [LAW:parse-dont-validate] The typed op, or null for anything that doesn't decode.
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

// [LAW:single-enforcer] THE one collector of a tree's segment names; a repeat collapses to one.
export function collectSegmentNames(root: LayoutNode): ReadonlySet<string> {
  const out = new Set<string>();
  for (const node of walkNodes(root)) {
    if (node.kind === "segment") out.add(node.name);
  }
  return out;
}
