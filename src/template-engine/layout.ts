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
  /**
   * Style for synthesized whitespace — RichText pads using plain spaces.
   * The padding inherits the cell's wrapping style at render time, so the
   * segment bg/fg is continuous across padded gaps without a second style
   * assignment here.
   */
  baseStyle?: Style;
  /** Cells drawn inside the cell before the sized content (SegmentNode.lead). */
  lead?: readonly RichText[];
  /** Cells drawn inside the cell after the sized content (SegmentNode.trail). */
  trail?: readonly RichText[];
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
  merged.overflow = "ignore";
  if (baseStyle !== undefined && !baseStyle.isNull) merged.style = baseStyle;
  return merged;
}

// [LAW:single-enforcer] The ONE sizing op: over a width, truncate with the
// authored mode and the one marker "…"; under it, align with the authored justify. Called
// for an authored integer width below, and again by the row's fill resolution
// once the leftover is known — a second spelling would drift the first time a
// truncation mode changes.
export interface CellSizing {
  readonly justify: JustifyMode;
  readonly truncate: TruncateMode;
}

export function sizeCell(cell: RichText, width: number, how: CellSizing): void {
  if (cell.cellLength > width) {
    cell.truncate(width, { mode: how.truncate, marker: "…" });
  } else if (cell.cellLength < width) {
    cell.align(how.justify, width);
  }
}

// [LAW:types-are-the-program] What one segment line lays out to: the ONE strip
// item it contributes, and — for a `width: "fill"` segment — its demand for the
// row's leftover width, with the sizing intent the row needs to honour it (the row
// finally sizes the cell and cannot ask the segment declaration again). The demand
// is a declared field of the cell, so code that rebuilds the text of a laid cell
// either carries the demand across or fails to typecheck. `resolveFill`
// (src/render/fill.ts) is where a row's laid cells become the strip items it
// serializes.
// [LAW:dataflow-not-control-flow] The demand is a VALUE riding the cell, not a
// shape in the walk: `composeBlocks` is generic over what a line's cells are, so
// it carries the demand through every container level without knowing it exists.
export interface LaidCell {
  readonly text: RichText;
  readonly fill?: CellSizing;
  // Drawn inside the cell before / after `text`, never resized with it
  // (SegmentNode.lead / .trail). Joined by `stripItem` once sizing is final.
  readonly lead?: RichText;
  readonly trail?: RichText;
}

// A laid cell's parts in drawing order — its lead, its sized text, its trail —
// as the objects the row's fill sizing will still grow in place: a copy joined
// now would record a fill cell at its natural width.
export function cellParts({ lead, text, trail }: LaidCell): RichText[] {
  return [
    ...(lead === undefined ? [] : [lead]),
    text,
    ...(trail === undefined ? [] : [trail]),
  ];
}

// The ONE strip item a laid cell serializes to: its parts, on the cell's own
// ground.
export function stripItem(cell: LaidCell): RichText {
  const parts = cellParts(cell);
  if (parts.length === 1) return cell.text;
  const joined = collapseToCell(parts);
  joined.style = cell.text.style;
  return joined;
}

/**
 * Lay out one segment visual line: collapse its cells into a single strip
 * item, then size that item to the requested width. Returns `[]` for an empty
 * line (a unit that rendered nothing contributes no strip item) or one laid
 * cell for one — never more, so the caller's branchless spread handles both.
 *
 * [LAW:dataflow-not-control-flow] `width` is the value that selects the sizing
 * op: "auto" keeps the content-sized cell as-is; a fixed width truncates when
 * over and pad-aligns when under; "fill" keeps it content-sized and states the
 * demand. Truncation/align are span-preserving, so the collapsed link
 * structure survives every cut.
 */
export function applySegmentLayout(
  cells: readonly RichText[],
  options: SegmentLayoutOptions,
): LaidCell[] {
  const {
    width,
    justify,
    truncate,
    baseStyle,
    padding,
    lead = [],
    trail = [],
  } = options;

  if (cells.length === 0) return [];

  // [LAW:one-source-of-truth] The DSL path's ONE intra-cell padding
  // application — the same rich-js pad primitive toCell (render/strip.ts)
  // uses on the legacy shape, threading the same resolved globals.padding.
  // pad() shifts spans, so OSC-8 link regions survive; the spaces inherit
  // the cell's wrapping style, so the segment bg is continuous.
  const cell = collapseToCell(cells, baseStyle).pad(padding);
  // The lead and trail are carried beside the content rather than joined here,
  // so the content alone is what any sizing — this call's or the row's fill —
  // resizes: a fixed width never truncates them away, and a fill's pad lands
  // between them. Each takes only its outer pad: the content's own pads
  // separate them from it.
  const pad = new RichText(" ".repeat(padding));
  const tail = {
    ...(lead.length > 0 && {
      lead: collapseToCell([pad, ...lead], baseStyle),
    }),
    ...(trail.length > 0 && {
      trail: collapseToCell([...trail, pad], baseStyle),
    }),
  };
  if (width === "auto") return [{ text: cell, ...tail }];
  const how: CellSizing = { justify, truncate };
  // "fill" leaves the cell content-sized and states its demand; the row resolves
  // it, since the leftover depends on siblings this call cannot see.
  if (width === "fill") return [{ text: cell, fill: how, ...tail }];
  sizeCell(cell, width, how);
  return [{ text: cell, ...tail }];
}
