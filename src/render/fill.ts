// A row's leftover width, given to the segments that asked for it
// (brandon-layout-0c2).
//
// `width: "fill"` cannot be resolved where it is authored: a segment knows its own
// content and nothing about its siblings, and the leftover is a fact about the ROW.
// So the segment states a demand on its cell (markFill, template-engine/layout.ts)
// and this module resolves every demand in one place, immediately before the row is
// serialized — the one seam where the cells and the width are both in hand
// [LAW:single-enforcer].
//
// Composition needed no change for this: `composeBlocks` concatenates the same cell
// objects, so a demand rides through every container level untouched.

import type { RichText } from "@promptctl/rich-js";
import { cellLen } from "@promptctl/rich-js";

import {
  fillDemandOf,
  sizeCell,
  type CellSizing,
} from "../template-engine/layout.js";
import { renderStripCells, type BuildLineOptions } from "./strip.js";

// eslint-disable-next-line no-control-regex
const INVISIBLE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x1b\\|\x07)/g;

// The columns a serialized line actually occupies. SGR and OSC-8 are zero-width,
// and `cellLen` is the same measure the strip wraps by, so this is the row's own
// arithmetic rather than a second opinion about character widths.
function visibleCols(serialized: string): number {
  return cellLen(serialized.replace(INVISIBLE, ""));
}

/**
 * Give every fill-demanding cell in one row its share of the leftover width.
 *
 * Returns the cells unchanged when nothing demanded fill — the common path, which
 * pays one scan — and when the width is not finite, because "the rest of the row"
 * means nothing against an unbounded row (the demo and the check command render at
 * Infinity, and a content-sized cell is the honest answer there).
 *
 * [LAW:no-ambient-temporal-coupling] The width the row already occupies is
 * MEASURED, not modelled: the row is serialized once as it stands, through the very
 * function that will serialize it for real, and each fill grows by its share of the
 * difference. A model of the joiner chrome would be a second theory of the strip's
 * geometry — and the numbers differ per style (powerline costs nothing inside the
 * budget, capsule and plain cost per seam) and for `plain` depend on the author's
 * own separator text, so the theory would have to track user data to stay true.
 */
export function resolveFill(
  cells: readonly RichText[],
  options: BuildLineOptions,
): readonly RichText[] {
  const demands: Array<{ cell: RichText; how: CellSizing }> = [];
  for (const cell of cells) {
    const how = fillDemandOf(cell);
    if (how !== undefined) demands.push({ cell, how });
  }
  if (demands.length === 0) return cells;
  if (!Number.isFinite(options.width)) return cells;

  // The row AS IT STANDS, through the very function that will serialize it for
  // real. No stand-in cell and no chrome model: whatever the joiner costs — nothing
  // inside the budget for powerline, per seam for capsule, the author's own
  // separator text for plain — it is already in this number.
  //
  // An emptied stand-in was the first attempt and was wrong in a way only
  // measurement would have caught: FlexStrip FOLDS THE LINE at a zero-width cell,
  // so the probe row wrapped and reported the width of its first fragment (4
  // columns instead of 9), and every fill came out five columns too wide.
  const natural = renderStripCells(cells, options).split("\n");
  // Already wrapping at its natural width: the row has no leftover to give, and
  // line 0 would under-report it anyway. The clamp case, reached honestly.
  if (natural.length > 1) return cells;

  const deficit = Math.max(0, options.width - visibleCols(natural[0] ?? ""));
  // Even shares of the deficit, remainder to the last demand so the row lands on
  // the width exactly rather than one column short per fill. Each fill GROWS from
  // its natural width, because that width is already inside the measurement above.
  const share = Math.floor(deficit / demands.length);
  const remainder = deficit - share * demands.length;
  demands.forEach(({ cell, how }, i) => {
    const grow = share + (i === demands.length - 1 ? remainder : 0);
    sizeCell(cell, cell.cellLength + grow, how);
  });
  return cells;
}
