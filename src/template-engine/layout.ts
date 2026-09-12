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
  /**
   * "auto" → content-sized; a positive integer → fixed terminal-cell width;
   * "fill" → content-sized HERE and marked for the ROW to resolve, because the
   * leftover is a fact about the row that no segment can see
   * (src/render/fill.ts).
   */
  width: "auto" | number | "fill";
  /** Alignment within a fixed-width segment. Ignored when width is "auto". */
  justify: JustifyMode;
  /** Overflow strategy when content exceeds a fixed width. Ignored when "auto". */
  truncate: TruncateMode;
  /**
   * Spaces synthesized inside the collapsed cell on each side (the resolved
   * globals.padding). [LAW:types-are-the-program] Required so every layout
   * site states the value — the walk threads the one render-wide resolution;
   * there is no per-site re-default. Applied BEFORE width sizing, so padding
   * sits inside a fixed `width` (the legacy intra-cell semantics: the joiners
   * sit between cells; padding sits inside the bg fill).
   */
  padding: number;
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
// [LAW:single-enforcer] The ONE sizing op: over a width, truncate with the
// authored mode and marker; under it, align with the authored justify. Called
// for an authored integer width below, and again by the row's fill resolution
// once the leftover is known — a second spelling would drift the first time a
// truncation mode changes.
export interface CellSizing {
  readonly justify: JustifyMode;
  readonly truncate: TruncateMode;
  readonly truncateMarker: string;
}

export function sizeCell(cell: RichText, width: number, how: CellSizing): void {
  if (cell.cellLength > width) {
    cell.truncate(width, { mode: how.truncate, marker: how.truncateMarker });
  } else if (cell.cellLength < width) {
    cell.align(how.justify, width);
  }
}

// [LAW:dataflow-not-control-flow] A fill demand is a VALUE riding the cell, not a
// shape in the walk's return type: `{{ menu }}` already carries its dropped body
// this way (MENU_DROP, src/render/menu.ts:91), which is this codebase's settled
// channel for render data one boundary produces and another consumes. The payoff
// is that composition needs no change at all — `composeBlocks` concatenates the
// same cell objects, so the demand survives every container level for free, and
// only the row about to be serialized resolves anything.
const FILL_DEMAND = Symbol("cc-candybar.fillDemand");
type FillCell = RichText & { [FILL_DEMAND]?: CellSizing };

// The sizing intent travels with the demand, because the late pass is the one
// that finally sizes the cell and it cannot ask the segment declaration again.
export function markFill(cell: RichText, how: CellSizing): RichText {
  (cell as FillCell)[FILL_DEMAND] = how;
  return cell;
}

export function fillDemandOf(cell: RichText): CellSizing | undefined {
  return (cell as FillCell)[FILL_DEMAND];
}

export function applySegmentLayout(
  cells: readonly RichText[],
  options: SegmentLayoutOptions,
): RichText[] {
  const {
    width,
    justify,
    truncate,
    truncateMarker = "…",
    baseStyle,
    padding,
  } = options;

  if (cells.length === 0) return [];

  // [LAW:one-source-of-truth] The DSL path's ONE intra-cell padding
  // application — the same rich-js pad primitive toCell (render/strip.ts)
  // uses on the legacy shape, threading the same resolved globals.padding.
  // pad() shifts spans, so OSC-8 link regions survive; the spaces inherit
  // the cell's wrapping style, so the segment bg is continuous.
  const cell = collapseToCell(cells, baseStyle).pad(padding);
  if (width === "auto") return [cell];
  const how: CellSizing = { justify, truncate, truncateMarker };
  // "fill" leaves the cell content-sized and states its demand; the row resolves
  // it, since the leftover depends on siblings this call cannot see.
  if (width === "fill") return [markFill(cell, how)];
  sizeCell(cell, width, how);
  return [cell];
}
