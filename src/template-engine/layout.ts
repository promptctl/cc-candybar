// [LAW:single-enforcer] All per-segment width/justify/truncate enforcement runs through applySegmentLayout; RichText owns the primitives.
// [LAW:dataflow-not-control-flow] Option values decide the output, never whether a step runs. [LAW:types-are-the-program] Every RichText layout op is span-preserving, so no slice-then-restyle path exists.

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
  /** [LAW:types-are-the-program] Required, so every site states the resolved globals.padding. Applied BEFORE width sizing, so padding sits inside a fixed `width`. */
  padding: number;
  /** Glyph inserted at the overflow cut point. Default "…". */
  truncateMarker?: string;
  /** Style for synthesized whitespace; padding inherits it at render time, so the segment bg/fg is continuous across padded gaps. */
  baseStyle?: Style;
}

/** [LAW:dataflow-not-control-flow] Visibility is a value: false only when the evaluated text is exactly "false"; a missing template is always visible. */
export function evaluateWhen(
  template: Template<RichText> | undefined,
  scope: object,
): boolean {
  if (template === undefined) return true;
  const fragments = template.evaluate(scope);
  return fragments.map((f) => f.plain).join("") !== "false";
}

/** [LAW:single-enforcer] A unit is ONE strip item — the joiner caps BETWEEN units, so interior bg/fg variation is paint, not a seam; interior spans (OSC-8 links included) carry through. */
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

/** [LAW:dataflow-not-control-flow] `width` selects the sizing op. Returns `[]` or `[cell]`, never more, so the caller's spread stays branchless. */
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

  // [LAW:one-source-of-truth] The DSL path's ONE intra-cell padding application; pad() shifts spans, so OSC-8 regions survive.
  const cell = collapseToCell(cells, baseStyle).pad(padding);
  if (width === "auto") return [cell];

  if (cell.cellLength > width) {
    cell.truncate(width, { mode: truncate, marker: truncateMarker });
  } else if (cell.cellLength < width) {
    cell.align(justify, width);
  }

  return [cell];
}
