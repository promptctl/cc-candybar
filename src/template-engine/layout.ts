// [LAW:single-enforcer] All per-segment width/justify/truncate enforcement
// runs through applySegmentLayout. RichText owns the slice/pad/truncate
// primitives; this function chooses which to call from the segment-level
// options. No second path exists.
//
// [LAW:dataflow-not-control-flow] Every step is unconditional in shape;
// option values (width, justify, truncate) decide what the output is, not
// whether the step runs. "auto" width is not a branch that skips logic —
// it is a value that selects "collapse only, no resize" over "collapse then
// size to width".
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
 * Collapse a visual line's cells into the ONE strip item the unit contributes
 * for that line. [LAW:single-enforcer] A unit (segment, or an inline leaf) is
 * one strip item — the powerline joiner caps BETWEEN units, never inside one,
 * so a unit's interior bg/fg variation is paint, not a structural seam the
 * joiner reads. Each input cell's wrapping style becomes a span over its range
 * and its interior spans (including OSC-8 links) carry through, so every
 * clickable region survives as its own span — serialized as one OSC-8 region
 * each. `baseStyle` is the wrapping default so synthesized padding and gaps
 * inherit the unit's bg.
 */
function collapseToCell(
  cells: readonly RichText[],
  baseStyle?: Style,
): RichText {
  const merged = RichText.fromFragments(cells);
  merged.end = "";
  merged.noWrap = true;
  if (baseStyle !== undefined && !baseStyle.isNull) merged.style = baseStyle;
  return merged;
}

/**
 * Lay out one segment visual line: collapse its cells into a single strip
 * item, then size that item to the requested width. Returns `[]` for an empty
 * line (a unit that rendered nothing contributes no strip item) or `[cell]`
 * for one — never more, so the caller's branchless spread handles both.
 *
 * [LAW:dataflow-not-control-flow] `width` is the value that selects the sizing
 * op: "auto" keeps the content-sized cell as-is; a fixed width truncates when
 * over and pad-aligns when under. Truncation/align are span-preserving, so the
 * collapsed link structure survives every cut.
 */
export function applySegmentLayout(
  cells: readonly RichText[],
  options: SegmentLayoutOptions,
): RichText[] {
  const { width, justify, truncate, truncateMarker = "…", baseStyle } = options;

  if (cells.length === 0) return [];

  const cell = collapseToCell(cells, baseStyle);
  if (width === "auto") return [cell];

  if (cell.cellLength > width) {
    cell.truncate(width, { mode: truncate, marker: truncateMarker });
  } else if (cell.cellLength < width) {
    cell.align(justify, width);
  }

  return [cell];
}
