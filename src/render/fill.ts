// A row's cells fitted to the width it is drawn at: the leftover given to the
// segments that asked for it (brandon-layout-0c2), and a cell wider than a line
// divided across lines.
//
// `width: "fill"` cannot be resolved where it is authored: a segment knows its own
// content and nothing about its siblings, and the leftover is a fact about the ROW.
// So the segment states a demand on its cell (`LaidCell.fill`,
// template-engine/layout.ts) and this module resolves every demand in one place,
// immediately before the row is drawn — the one seam where the cells and the
// width are both in hand [LAW:single-enforcer].
//
// A row breaks only between strip items, and FlexStrip draws an item as one
// block, so a cell wider than a line has to reach it as several items. Claude
// Code draws each line of the bar truncated, so a line left over-wide loses its
// right end where the bar cannot see it.

import { cellLen, type RichText } from "@promptctl/rich-js";

import {
  sizeCell,
  stripItem,
  type CellSizing,
  type LaidCell,
} from "../template-engine/layout.js";
import {
  drawStripCells,
  lineWidth,
  stripChromeCols,
  stripSeamCols,
  WIDEST_GLYPH_COLS,
  wrappedLines,
  type BuildLineOptions,
} from "./strip.js";
import { plainOf } from "./frame.js";
import type { RowItem } from "./effect.js";

// The offsets `plain` wraps to `line` at, its first line starting `indent` cells
// in. The indent is wrapped as a word ahead of the text, so a first word that
// doesn't fit beside it moves to the next line whole, and no offset falls inside
// it. Each wrapped line is found by searching forward for its content, the line
// less the whitespace hanging off its end: rich-js crops that whitespace at the
// edge, and half of a full-width space draws as a narrow one, so it is neither
// countable nor a slice of the text. A line of nothing but that whitespace
// starts nothing.
function wrapOffsets(plain: string, line: number, indent: number): number[] {
  const held = "x".repeat(Math.min(indent, line)).replace(/x$/, " ");
  const wrapping = held + plain;
  const offsets: number[] = [];
  let at = 0;
  wrappedLines(wrapping, line).forEach((wrapped) => {
    const content = wrapped.trimEnd();
    const start = wrapping.indexOf(content, at);
    if (content !== "" && start > held.length)
      offsets.push(start - held.length);
    at = start + content.length;
  });
  return offsets;
}

// The cells an item joining `before` finds taken on its line. Measured through
// the draw that will write them, as a fill's leftover is. An unpainted line draws
// no caps to take back, so this reads two short of it, and a piece that doesn't
// fit there takes the next line as any strip item does.
function takenOnLine(
  before: readonly RowItem[],
  options: BuildLineOptions,
): number {
  if (before.length === 0) return 0;
  const { lines } = drawStripCells(
    before.map(({ owner }) => owner),
    options,
  );
  const last = cellLen(plainOf(lines[lines.length - 1]!));
  return Math.max(0, last - stripChromeCols(options) + stripSeamCols(options));
}

// Whether a cell stands as it is. One that clears a line does, however it is
// painted. Past that, the caps are drawn only where the cell is painted, so what
// decides is the cell measured through the draw that will write it.
function fits(
  cell: RichText,
  line: number,
  options: BuildLineOptions,
): boolean {
  if (cell.cellLength <= line) return true;
  const { lines } = drawStripCells([cell], { ...options, width: Infinity });
  return cellLen(plainOf(lines.flat())) <= options.width;
}

// A strip item as the items it takes to fit `line`, each keeping the item's
// placement. Tabs expand first because rich-js expands them before it wraps, so
// a line holding one has no offset in the unexpanded text. The crop removes only
// whitespace left hanging past a break. A blank piece is a justified cell's
// padding and spends a row on nothing, so it goes, unless the cell is only that:
// an all-space cell keeps a line of its spaces, since FlexStrip folds the line at
// a zero-width item. The first piece starts on the line `before` left open, or a
// short cell ahead of it stands alone on a row. A piece is a cell, so one that
// opens a line wears the cell's padding; `line` holds the room for it.
function dividedToLine(
  item: RowItem,
  line: number,
  before: readonly RowItem[],
  options: BuildLineOptions,
): readonly RowItem[] {
  if (fits(item.owner, line, options)) return [item];
  const text = item.owner.copy().expandTabs();
  const indent = takenOnLine(before, options);
  return text
    .divide(wrapOffsets(text.plain, line, indent))
    .filter(({ plain }, _, { length }) => length === 1 || plain.trim() !== "")
    .map((piece, i) => ({
      ...item,
      owner: piece
        .truncate(line, { marker: "" })
        .padLeft(i > 0 ? options.padding : 0),
    }));
}

/**
 * Fit one row to the width it is drawn at, returning the strip items it draws,
 * each beside the effect its cell demands. Fill settles first, because a fill
 * grows only a row that fits; then any item still wider than a line is divided.
 *
 * [LAW:dataflow-not-control-flow] A line is the width less the strip's caps and
 * a piece's padding, floored at the widest glyph: below that nothing fits and the
 * fold has to stay finite. `autoWrap` off or an unbounded width make it Infinity,
 * a value under which no item divides.
 *
 * `stripChromeCols` is a painted cell's caps, the most a cell costs, so a piece
 * fits however it is painted. An unpainted cell that does divide wraps two
 * columns early and its pieces can share a line with no seam between them.
 */
export function fitRow(
  row: readonly LaidCell[],
  options: BuildLineOptions,
): readonly RowItem[] {
  const line = Math.max(
    WIDEST_GLYPH_COLS,
    lineWidth(options) - stripChromeCols(options) - options.padding,
  );
  return filled(row, options).reduce<readonly RowItem[]>(
    (fitted, item) => [
      ...fitted,
      ...dividedToLine(item, line, fitted, options),
    ],
    [],
  );
}

/**
 * Give every fill-demanding cell in one row its share of the leftover width, and
 * return the row as strip items, each beside the effect
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
function filled(
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
