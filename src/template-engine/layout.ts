// [LAW:single-enforcer] All per-segment width/justify/truncate enforcement
// runs through applySegmentLayout. No second path; two paths would silently
// drift.
//
// [LAW:dataflow-not-control-flow] Every step is unconditional; option values
// (width, justify, truncate) are the data that drives the output. "auto" width
// is not a branch that skips logic — it is a value that makes the step return
// the input unchanged.
//
// The bg/fg default-style cascade is applied at cell construction time in
// `fragmentsToStripCells(fragments, baseStyle)`, not by rebuilding cells here.
// But layout ALSO synthesizes new cells (pad spaces for justify, truncate
// marker glyph) — those new cells need the same segment baseStyle so the
// PowerlineJoiner sees one continuous bg run across the segment and the marker
// glyph is rendered in segment fg, not as an unstyled gap. `baseStyle` flows
// into layout for that single, narrow purpose: filling cells layout itself
// creates. Existing cells flow through with their own style intact.

import { StripCell, cellLen, splitText, asCellCol } from "@promptctl/rich-js";
import type { RichText, Style } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";

export type JustifyMode = "left" | "center" | "right";
export type TruncateMode = "right" | "left" | "middle";

export interface SegmentLayoutOptions {
  /** "auto" → content-sized; a positive integer → fixed terminal-cell width. */
  width: "auto" | number;
  /** Alignment within a fixed-width segment. Ignored when width is "auto". */
  justify: JustifyMode;
  /** Overflow strategy when content exceeds a fixed width. Ignored when "auto". */
  truncate: TruncateMode;
  /** Glyph appended/prepended/inserted at the overflow cut point. Default "…". */
  truncateMarker?: string;
  /**
   * Style for cells layout itself synthesizes — padding spaces and the
   * truncate marker. Existing cells flow through with their own style; this
   * fills only the new ones. Pass the same resolved segment baseStyle used
   * for `fragmentsToStripCells(fragments, baseStyle)` so the PowerlineJoiner
   * sees one continuous bg run across the whole segment.
   */
  baseStyle?: Style;
}

/**
 * Evaluate a `when` predicate template against `scope`.
 * Returns false only when the evaluated text equals the string "false".
 * A missing template means the segment is always visible.
 *
 * [LAW:dataflow-not-control-flow] Visibility is a value that flows out of the
 * template engine. The engine always runs; the output value decides visibility.
 */
export function evaluateWhen(
  template: Template<RichText> | undefined,
  scope: object,
): boolean {
  if (template === undefined) return true;
  const fragments = template.evaluate(scope);
  return fragments.map((f) => f.plain).join("") !== "false";
}

/**
 * Apply per-segment layout constraints to a list of StripCells produced by
 * fragmentsToStripCells().
 *
 * Steps (always executed in order; values govern output, not whether steps run):
 *   1. "auto" width → return cells as-is.
 *   2. Fixed width → truncate on overflow or pad for justification.
 *
 * Existing cells flow through with their own style (baked in upstream by
 * `fragmentsToStripCells(fragments, baseStyle)`). New cells synthesized here
 * (pad spaces, truncate marker) inherit `options.baseStyle` so the segment's
 * bg/fg is continuous across them.
 */
export function applySegmentLayout(
  cells: StripCell[],
  options: SegmentLayoutOptions,
): StripCell[] {
  const { width, justify, truncate, truncateMarker = "…", baseStyle } = options;

  // Step 1: "auto" — content-sized, no constraint.
  if (width === "auto") return cells;

  // Step 2: fixed width — measure, then truncate or pad.
  const total = totalCellWidth(cells);

  return total > width
    ? truncateCells(cells, width, truncate, truncateMarker, baseStyle)
    : padCells(cells, width, justify, total, baseStyle);
}

// ─── Width measurement ───────────────────────────────────────────────────────

function totalCellWidth(cells: StripCell[]): number {
  return cells.reduce((sum, c) => sum + cellLen(c.text), 0);
}

// ─── Truncation ──────────────────────────────────────────────────────────────

function truncateCells(
  cells: StripCell[],
  targetWidth: number,
  mode: TruncateMode,
  marker: string,
  baseStyle: Style | undefined,
): StripCell[] {
  const markerWidth = cellLen(marker);
  const budget = Math.max(0, targetWidth - markerWidth);
  const markerCell = new StripCell(marker, baseStyle);

  if (mode === "right") {
    return [...keepFromLeft(cells, budget), markerCell];
  }

  if (mode === "left") {
    return [markerCell, ...keepFromRight(cells, budget)];
  }

  // middle: keep equal halves from both ends
  const leftBudget = Math.floor(budget / 2);
  const rightBudget = budget - leftBudget;
  return [
    ...keepFromLeft(cells, leftBudget),
    markerCell,
    ...keepFromRight(cells, rightBudget),
  ];
}

/**
 * Take cells from the left, up to `budget` terminal columns.
 * The boundary cell's text is sliced via splitText() if it partially fits.
 *
 * [LAW:types-are-the-program] Known limitation: when the boundary cell is
 * parts-based (heterogeneous per-part fg/attrs under a shared cell-level
 * bg — only gitTaculous-shaped segments today), the slice rebuilds as
 * `new StripCell(splitText(cell.text), cell.style)`, where `cell.style`
 * carries only the cell-level bgcolor. Per-part fg/attrs are dropped on
 * the cut. rich-js's StripCell does not expose `_parts` publicly, so
 * slicing parts directly is not available. `groupToCell` already collapses
 * uniform-style multi-fragment groups to single-text cells (the common
 * case), so this affects ONLY segments that have *genuinely heterogeneous*
 * fg AND a fixed width that triggers truncation through a styled run —
 * no current segment configures that combination. Behavior is pinned by
 * `test/segment-layout.test.ts` (truncation through parts-based cell).
 */
function keepFromLeft(cells: StripCell[], budget: number): StripCell[] {
  let remaining = budget;
  const result: StripCell[] = [];

  for (const cell of cells) {
    if (remaining <= 0) break;
    const w = cellLen(cell.text);
    if (w <= remaining) {
      result.push(cell);
      remaining -= w;
    } else {
      const [left] = splitText(cell.text, asCellCol(remaining));
      if (left) result.push(new StripCell(left, cell.style));
      remaining = 0;
    }
  }

  return result;
}

/**
 * Take cells from the right, up to `budget` terminal columns.
 * The boundary cell's text is sliced via splitText() if it partially fits.
 *
 * Same parts-based-cell limitation as keepFromLeft applies on the right
 * boundary; see that function's comment for details.
 */
function keepFromRight(cells: StripCell[], budget: number): StripCell[] {
  let remaining = budget;
  const result: StripCell[] = [];

  for (let i = cells.length - 1; i >= 0; i--) {
    if (remaining <= 0) break;
    const cell = cells[i]!;
    const w = cellLen(cell.text);
    if (w <= remaining) {
      result.unshift(cell);
      remaining -= w;
    } else {
      // Take the right `remaining` columns: split at (w - remaining) from left.
      const [, right] = splitText(cell.text, asCellCol(w - remaining));
      if (right) result.unshift(new StripCell(right, cell.style));
      remaining = 0;
    }
  }

  return result;
}

// ─── Justification ───────────────────────────────────────────────────────────

function padCells(
  cells: StripCell[],
  targetWidth: number,
  justify: JustifyMode,
  currentWidth: number,
  baseStyle: Style | undefined,
): StripCell[] {
  const padAmount = targetWidth - currentWidth;
  if (padAmount <= 0) return cells;

  const pad = (n: number) => new StripCell(" ".repeat(n), baseStyle);

  if (justify === "left") return [...cells, pad(padAmount)];
  if (justify === "right") return [pad(padAmount), ...cells];

  // center: split pad, left side gets the smaller half
  const leftPad = Math.floor(padAmount / 2);
  const rightPad = padAmount - leftPad;
  return [pad(leftPad), ...cells, pad(rightPad)];
}
