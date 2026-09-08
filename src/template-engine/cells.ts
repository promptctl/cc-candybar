// [LAW:dataflow-not-control-flow] The walk is unconditional; style.link decides whether a fragment becomes its own cell.
// [LAW:one-type-per-behavior] Cells are RichText: joiners ask only for edge style, so a cell's interior may vary freely.

import { RichText } from "@promptctl/rich-js";
import type { Style } from "@promptctl/rich-js";

/** [LAW:single-enforcer] The only fragments→cells mapper: splits at OSC-8 link boundaries so each clickable region is its own cell; `baseStyle` wraps the cell. */
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
  // baseStyle merges UNDER each fragment's style, so the segment default reaches every character and lands as an addressable span.
  const layered =
    baseStyle !== undefined && !baseStyle.isNull
      ? fragments.map((f) => withBaseStyle(f, baseStyle))
      : fragments;
  const cell = RichText.fromFragments(layered);
  cell.end = "";
  cell.noWrap = true;
  // [LAW:one-source-of-truth] A single-fragment cell wears that fragment's style, keeping the link claim at cell level where joiners and click dispatch read it.
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
