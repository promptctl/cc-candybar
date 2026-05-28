// [LAW:single-enforcer] All per-segment width/justify/truncate enforcement
// runs through applySegmentLayout. RichText owns the slice/pad/truncate
// primitives; this function chooses which to call from the segment-level
// options. No second path exists.
//
// [LAW:dataflow-not-control-flow] Every step is unconditional in shape;
// option values (width, justify, truncate) decide what the output is, not
// whether the step runs. "auto" width is not a branch that skips logic —
// it is a value that makes the function return the input unchanged.
//
// [LAW:types-are-the-program] With RichText as the cell type, every layout
// operation is span-preserving by construction. There is no rebuild path,
// no slice-then-restyle dance: `richText.truncate({width, mode, marker})`
// and `richText.align(justify, width)` clip and shift spans through every
// cut. The bzh.9 limitation (truncation drops per-part fg) cannot be
// expressed in this shape — its preconditions don't exist.

import { RichText } from "@promptctl/rich-js";
import type { Style } from "@promptctl/rich-js";
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
  /** Glyph inserted at the overflow cut point. Default "…". */
  truncateMarker?: string;
  /**
   * Style for synthesized whitespace — RichText pads using plain spaces.
   * The padding inherits the cell's wrapping style at render time, so the
   * segment bg/fg is continuous across padded gaps without a second style
   * assignment here.
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
 * Apply per-segment layout constraints to the cells produced by
 * `fragmentsToCells()`. Returns a (possibly different-length) RichText[]
 * that fits the requested width.
 *
 * Multi-cell input is concatenated into a single RichText before layout,
 * because layout decisions (truncation across cell boundaries, justify
 * padding) are joint properties of the whole segment. The OSC-8 link
 * structure is preserved via spans across the concatenation. After
 * layout, the result is returned as a single-cell array — the join
 * structure is now interior to that one cell.
 */
export function applySegmentLayout(
  cells: readonly RichText[],
  options: SegmentLayoutOptions,
): RichText[] {
  const { width, justify, truncate, truncateMarker = "…", baseStyle } = options;

  if (cells.length === 0) return [];

  // Step 1: "auto" — content-sized, no width-driven constraint. Pass
  // cells through unchanged so each link-cell stays its own cell (the
  // Strip joiner can render edges between them).
  if (width === "auto") return cells.slice();

  // Step 2: fixed width — merge cells into one RichText so layout ops
  // (truncate, align) operate across the segment.
  const merged = mergeCells(cells, baseStyle);
  if (merged.cellLength > width) {
    merged.truncate(width, { mode: truncate, marker: truncateMarker });
  } else if (merged.cellLength < width) {
    merged.align(justify, width);
  }

  return [merged];
}

function mergeCells(
  cells: readonly RichText[],
  baseStyle: Style | undefined,
): RichText {
  if (cells.length === 1) {
    const c = cells[0]!.copy();
    c.end = "";
    c.noWrap = true;
    if (baseStyle !== undefined && !baseStyle.isNull) c.style = baseStyle;
    return c;
  }
  const merged = RichText.fromFragments(cells);
  merged.end = "";
  merged.noWrap = true;
  if (baseStyle !== undefined && !baseStyle.isNull) merged.style = baseStyle;
  return merged;
}
