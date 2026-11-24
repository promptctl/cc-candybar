// What the pointer is on in the frame the pane last painted: the link a press
// opens there, and the action hover names.
//
// [LAW:effects-at-boundaries] Pure.

import { gestureName, type Gesture } from "../click/gesture.js";
import type { Hit, HitMap } from "../render/hit-map.js";
import type { Cell } from "./mouse.js";
import { lineAtRow } from "./paint.js";

// [LAW:one-source-of-truth] The region under a cell, through the paint's own
// answer for which frame line a terminal row shows.
function hitAt(hits: HitMap, paneRows: number, at: Cell): Hit | undefined {
  const line = lineAtRow(at.row, paneRows, hits.length);
  const column = at.column - 1;
  return line === null
    ? undefined
    : hits[line]?.find((hit) => hit.from <= column && column < hit.to);
}

// The link a press opens: the signed link the frame holds for this gesture on
// the cell pressed, or none, and a press on a cell with none runs nothing.
// [LAW:single-enforcer] The pane runs only what the frame signed: it cannot
// make a link, only find one.
export function linkPressed(
  hits: HitMap,
  paneRows: number,
  at: Cell,
  gesture: Gesture,
): string | undefined {
  return hitAt(hits, paneRows, at)?.links[gestureName(gesture)];
}

// The action the pointer is on, or null: a cell with no region has none, and
// neither has a region drawn from a literal href, which names no action.
export function actionAt(
  hits: HitMap,
  paneRows: number,
  at: Cell,
): string | null {
  return hitAt(hits, paneRows, at)?.action ?? null;
}
