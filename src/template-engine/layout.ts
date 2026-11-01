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
import type { CellPlacement } from "../render/effect.js";
import { resolvedStyle } from "../render/rich-theme.js";
import { readPending } from "../var-system/types.js";

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
  /**
   * The placement the cell belongs to and the effect it wears.
   * [LAW:types-are-the-program] Required, like `padding`, so every cell a
   * placement lays — inline, a dropped band, a body's lead, its ⚠ — names it:
   * none can follow the bar, or be missed when its placement appears, by being
   * forgotten.
   */
  placement: CellPlacement;
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

// [LAW:types-are-the-program] What a layout node's own `when` decided: shown,
// hidden, not yet — it reads `variable`, whose source has not answered — or
// neither: its template threw, and `message` says why. What a pending or a
// failed gate costs is the node type's to say (brandon-unfiled-3248.ryf).
export type Gate =
  | { readonly kind: "shown" }
  | { readonly kind: "hidden" }
  | { readonly kind: "pending"; readonly variable: string }
  | { readonly kind: "failed"; readonly message: string };

export const HIDDEN = { kind: "hidden" } as const satisfies Gate;
export const SHOWN = { kind: "shown" } as const satisfies Gate;

// [LAW:no-silent-failure] evaluateWhen with its throw as a value: a gate that
// fails is one node's fault, so it reaches that node rather than unwinding the
// walk and taking every other node with it. A gate over a value not answered
// yet is not a failure, and `readPending` is the one thing that says so.
export function gateOf(
  template: Template<RichText> | undefined,
  scope: object,
): Gate {
  try {
    return evaluateWhen(template, scope) ? SHOWN : HIDDEN;
  } catch (e) {
    const pending = readPending(e);
    return pending !== undefined
      ? { kind: "pending", variable: pending.variable }
      : {
          kind: "failed",
          message: e instanceof Error ? e.message : String(e),
        };
  }
}

/**
 * Collapse a visual line's cells into the ONE strip item the unit contributes
 * for that line. [LAW:single-enforcer] A unit (segment, or an inline leaf) is
 * laid as one strip item, which its row divides only when it is wider than a
 * line (src/render/fill.ts) — the powerline joiner caps BETWEEN units, never
 * inside one, so a unit's interior bg/fg variation is paint, not a structural seam the
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
// either carries the demand across or fails to typecheck. `fitRow`
// (src/render/fill.ts) is where a row's laid cells become the strip items it
// serializes.
// [LAW:dataflow-not-control-flow] The demand is a VALUE riding the cell, not a
// shape in the walk: `composeBlocks` is generic over what a line's cells are, so
// it carries the demand through every container level without knowing it exists.
export interface LaidCell {
  readonly text: RichText;
  readonly fill?: CellSizing;
  // The placement the cell belongs to and the effect it wears — the bar's or
  // its own (brandon-effects-2gka.bm1): a demand like `fill`, settled where the
  // row's strip is drawn (`SessionEffects.motion`), the one place the row's
  // items and the bar's effect are both in hand — which is also where a
  // placement fading in (brandon-effects-2gka.631) or dissolving out
  // (brandon-effects-2gka.3vt) has its transition confined to its own cells.
  readonly placement: CellPlacement;
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

// A laid cell as a placement leaving the bar replays it
// (brandon-effects-2gka.3vt): sized as its row last drew it — the row's fill
// grows a cell in place, so the copy keeps that width and asks the row for
// nothing — and with every link and click handler removed, since a placement
// on its way out offers nothing to click.
export function heldCell({ text, placement, lead, trail }: LaidCell): LaidCell {
  return {
    text: unlinked(text),
    placement,
    ...(lead !== undefined && { lead: unlinked(lead) }),
    ...(trail !== undefined && { trail: unlinked(trail) }),
  };
}

function unlinked(text: RichText): RichText {
  const copy = text.blankCopy(text.plain);
  copy.style = resolvedStyle(text.style).clearMetaAndLinks();
  for (const { start, end, style } of text.spans)
    copy.stylize(resolvedStyle(style).clearMetaAndLinks(), start, end);
  return copy;
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
    placement,
    lead = [],
    trail = [],
  } = options;

  if (cells.length === 0) return [];

  // [LAW:one-source-of-truth] The DSL path's ONE intra-cell padding
  // application, threading the resolved globals.padding.
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
    placement,
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
