// Which link a press on the pane opens, by the frame the pane last painted.
//
// [LAW:effects-at-boundaries] Pure.

import { gestureName, type Gesture } from "../click/gesture.js";
import type { HitMap } from "../render/hit-map.js";
import type { Cell } from "./mouse.js";
import { lineAtRow } from "./paint.js";

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
  const line = lineAtRow(at.row, paneRows, hits.length);
  const column = at.column - 1;
  return line === null
    ? undefined
    : hits[line]?.find((hit) => hit.from <= column && column < hit.to)?.links[
        gestureName(gesture)
      ];
}
