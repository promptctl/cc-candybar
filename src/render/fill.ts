// A row's leftover width, given to the segments that asked for it
// (brandon-layout-0c2).
//
// `width: "fill"` cannot be resolved where it is authored: a segment knows its own
// content and nothing about its siblings, and the leftover is a fact about the ROW.
// So the segment states a demand on its cell (`LaidCell.fill`,
// template-engine/layout.ts) and this module resolves every demand in one place,
// immediately before the row is drawn — the one seam where the cells and the
// width are both in hand [LAW:single-enforcer].

import { cellLen } from "@promptctl/rich-js";

import {
  sizeCell,
  stripItem,
  type CellSizing,
  type LaidCell,
} from "../template-engine/layout.js";
import { drawStripCells, type BuildLineOptions } from "./strip.js";
import { plainOf } from "./frame.js";
import type { RowItem } from "./effect.js";

/**
 * Give every fill-demanding cell in one row its share of the leftover width, and
 * return the row as the strip items it draws, each beside the effect
 * its cell demands — the cell's other demand, settled where its row is drawn,
 * so it travels with the item it was laid as rather than by position.
 *
 * Leaves every cell content-sized when nothing demanded fill — the common path,
 * which pays one scan — and when the width is not finite, because "the rest of the row"
 * means nothing against an unbounded row (the demo and the check command render at
 * Infinity, and a content-sized cell is the honest answer there).
 *
 * [LAW:no-ambient-temporal-coupling] The width the row already occupies is
 * MEASURED, not modelled: the row is drawn once as it stands, through the very
 * function that will draw it for real, and each fill grows by its share of the
 * difference. A model of the joiner chrome would be a second theory of the strip's
 * geometry — and the numbers differ per endcaps shape (caps per row for powerline and
 * capsule, a cost per seam for every shape) and for `plain` depend on the author's
 * own separator text, so the theory would have to track user data to stay true.
 */
export function resolveFill(
  row: readonly LaidCell[],
  options: BuildLineOptions,
): readonly RowItem[] {
  // The row's items as its cells stand: once sized, every fill's lead and trail
  // rejoin it here.
  const items = (): RowItem[] =>
    row.map((cell) => ({ owner: stripItem(cell), placement: cell.placement }));
  const demands: Array<{ at: number; how: CellSizing }> = [];
  row.forEach(({ fill }, at) => {
    if (fill !== undefined) demands.push({ at, how: fill });
  });
  if (demands.length === 0) return items();
  if (!Number.isFinite(options.width)) return items();

  // The row AS IT STANDS, through the very function that will draw it for
  // real. No stand-in cell and no chrome model: whatever the joiner costs — caps
  // and seams for powerline and capsule, the author's own separator text for
  // plain — it is already in this number.
  //
  // An emptied stand-in was the first attempt and was wrong in a way only
  // measurement would have caught: FlexStrip FOLDS THE LINE at a zero-width cell,
  // so the probe row wrapped and reported the width of its first fragment (4
  // columns instead of 9), and every fill came out five columns too wide.
  const natural = drawStripCells(row.map(stripItem), options).lines;
  // Already wrapping at its natural width: the row has no leftover to give, and
  // line 0 would under-report it anyway. The clamp case, reached honestly.
  if (natural.length > 1) return items();

  // `cellLen` is the measure the strip wraps by, so this is the row's own
  // arithmetic rather than a second opinion about character widths.
  const deficit = Math.max(0, options.width - cellLen(plainOf(natural.flat())));
  // Even shares of the deficit, remainder to the last demand so the row lands on
  // the width exactly rather than one column short per fill. Each fill GROWS from
  // its natural width, because that width is already inside the measurement above.
  const share = Math.floor(deficit / demands.length);
  const remainder = deficit - share * demands.length;
  // The content grows, then its lead and trail rejoin: a left-justified fill
  // pads BEFORE the trail, never after it.
  demands.forEach(({ at, how }, i) => {
    const grow = share + (i === demands.length - 1 ? remainder : 0);
    const { text } = row[at]!;
    sizeCell(text, text.cellLength + grow, how);
  });
  return items();
}
