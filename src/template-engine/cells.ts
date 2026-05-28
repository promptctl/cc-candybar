// [LAW:dataflow-not-control-flow] The fragment walk is unconditional: every
// fragment is visited; style.link (a value on the fragment) decides whether
// it becomes its own cell or coalesces with neighbours. No branching on
// "are there any cells" — variability lives entirely in the data.
//
// [LAW:one-type-per-behavior] Cells are RichText. There is no parallel
// "cell" type with a single-bg invariant: rich-js's joiner protocol asks
// each item only for its edge style, so the interior can vary freely.
// What was previously expressed as "split this run into N cells at bg
// boundaries" or "lift the modal style to cell-level so parts survive a
// slice" is now structurally impossible to need — RichText carries per-
// character styling via spans, and every layout op (truncate / align /
// pad / slice) preserves spans by construction.

import { RichText } from "@promptctl/rich-js";
import type { Style } from "@promptctl/rich-js";

/**
 * Convert template-engine fragments (`RichText[]`) into Strip cells
 * (`RichText[]`), splitting at OSC-8 link boundaries so each clickable
 * region is its own cell. Non-link runs coalesce into one cell whose
 * interior styling is carried as spans.
 *
 * `baseStyle` is the segment-level default (resolved bg + fg). It becomes
 * the cell's wrapping style so segment-wide bg+fg cascade across every
 * character, and per-fragment fg overlays land as spans on top.
 *
 * [LAW:single-enforcer] The only mapper from template fragments to Strip
 * cells. Callers do not assemble cells by hand.
 */
export function fragmentsToCells(
  fragments: RichText[],
  baseStyle?: Style,
): RichText[] {
  const cells: RichText[] = [];
  let group: RichText[] = [];

  const flush = () => {
    if (!group.length) return;
    const cell = buildCell(group, baseStyle);
    if (cell.plain.length > 0) cells.push(cell);
    group = [];
  };

  for (const frag of fragments) {
    if (frag.style.link) {
      flush();
      const cell = buildCell([frag], baseStyle);
      if (cell.plain.length > 0) cells.push(cell);
    } else {
      group.push(frag);
    }
  }
  flush();

  return cells;
}

function buildCell(fragments: RichText[], baseStyle?: Style): RichText {
  // [LAW:types-are-the-program] Each fragment carries its own style (and
  // possibly spans). We merge baseStyle UNDER each fragment's style before
  // assembling so the segment-wide default flows through every character,
  // with the fragment's own style winning on overlap. That merged style
  // then lands as a span on the assembled RichText, so per-fragment styles
  // are addressable as overlays.
  const layered =
    baseStyle !== undefined && !baseStyle.isNull
      ? fragments.map((f) => withBaseStyle(f, baseStyle))
      : fragments;
  const cell = RichText.fromFragments(layered);
  cell.end = "";
  cell.noWrap = true;
  // [LAW:one-source-of-truth] For a single-fragment cell (a link cell, or a
  // single-styled non-link fragment), the cell's wrapping style IS that
  // fragment's effective style. This keeps the link / linked-region claim
  // structurally at cell level (where joiners and click dispatch read it)
  // and matches the old per-cell-style contract.
  if (layered.length === 1) {
    cell.style = layered[0]!.style;
  } else if (baseStyle !== undefined && !baseStyle.isNull) {
    cell.style = baseStyle;
  }
  return cell;
}

function withBaseStyle(f: RichText, base: Style): RichText {
  const copy = f.copy();
  copy.style = base.add(f.style);
  return copy;
}
