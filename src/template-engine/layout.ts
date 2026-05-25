// [LAW:single-enforcer] All per-segment width/justify/truncate enforcement
// runs through applySegmentLayout. No second path; two paths would silently
// drift.
//
// [LAW:dataflow-not-control-flow] Every step is unconditional; option values
// (width, justify, truncate) are the data that drives the output. "auto" width
// is not a branch that skips logic — it is a value that makes the step return
// the input unchanged.
//
// The bg/fg default-style cascade does NOT live here. It is applied at cell
// construction time in `fragmentsToStripCells(fragments, baseStyle)`. Merging at
// the cell layer was structurally wrong: rebuilding cells via
// `new StripCell(c.text, merged)` dropped per-fragment fg (parts) because
// `_parts` is private on rich-js's StripCell. Moving the merge upstream — onto
// fragments before they become cells — preserves parts by construction.

import { StripCell, cellLen, splitText, asCellCol } from "@promptctl/rich-js";
import type { RichText } from "@promptctl/rich-js";
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
 * Defaults (bg/fg) are baked into cells by fragmentsToStripCells's `baseStyle`
 * parameter — by the time cells reach this function their style is final.
 */
export function applySegmentLayout(
  cells: StripCell[],
  options: SegmentLayoutOptions,
): StripCell[] {
  const { width, justify, truncate, truncateMarker = "…" } = options;

  // Step 1: "auto" — content-sized, no constraint.
  if (width === "auto") return cells;

  // Step 2: fixed width — measure, then truncate or pad.
  const total = totalCellWidth(cells);

  return total > width
    ? truncateCells(cells, width, truncate, truncateMarker)
    : padCells(cells, width, justify, total);
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
): StripCell[] {
  const markerWidth = cellLen(marker);
  const budget = Math.max(0, targetWidth - markerWidth);
  const markerCell = new StripCell(marker);

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
): StripCell[] {
  const padAmount = targetWidth - currentWidth;
  if (padAmount <= 0) return cells;

  const pad = (n: number) => new StripCell(" ".repeat(n));

  if (justify === "left") return [...cells, pad(padAmount)];
  if (justify === "right") return [pad(padAmount), ...cells];

  // center: split pad, left side gets the smaller half
  const leftPad = Math.floor(padAmount / 2);
  const rightPad = padAmount - leftPad;
  return [pad(leftPad), ...cells, pad(rightPad)];
}
