// [LAW:one-source-of-truth] `{{ layoutPreview }}` — the arrangement the bar is
// in, drawn small (brandon-theme-picker-bgw.x2m): one line per row of the
// active preset's layout, each segment a labelled block in the tint its place
// in that layout deals it. It exists because the settings menu opens INLINE,
// taking over the door's row, so while the preset carousel is open the bar
// itself cannot show its own first row — and a one-row preset shows none of
// its arrangement at all.
//
// Nothing here chooses a segment, a row or a colour. The rows are
// `layoutRows` of the compiled tree the render is walking, under the walk's
// own visibility (`ActionRuntime.layout`, published by renderDsl); each tint
// is `decorationFor` of the segment's bar address — the function the walk
// colours every closed cell with — on the palette that segment renders in.
// An authored `bg:` is not what a block wears: it states a fact about live
// data (a threshold, an alert), not about where the segment sits.
//
// [LAW:one-way-deps] Lives in render/, injected into the engine as data by
// registerDslConfig; the generic engine never imports it.

import { RichText } from "@promptctl/rich-js";
import type { ColorDepth, Palette } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import type { PlacedSegment } from "../dsl/node-registry.js";
import { decorationFor } from "../themes/decor.js";
import type { ActionRuntime } from "./action.js";
import type { ActiveSegmentRef } from "./active-segment.js";
import { stateCell } from "./band-style.js";
import { cellWidth, ledRowBudget } from "./picker.js";

/** A segment the preview draws: where the layout puts it, and the palette it renders in. */
export interface PreviewSegment extends PlacedSegment {
  readonly palette: Palette;
}

/** The preview's rows, top to bottom, each its segments left to right. */
export type PreviewRows = ReadonlyArray<readonly PreviewSegment[]>;

// What a block says: the segment's own name, less any namespace — the door is
// `settings.menu`, and "menu" is what it is.
export const blockLabel = (name: string): string =>
  name.slice(name.lastIndexOf(".") + 1);

// A label cut to `most` columns, the cut marked so a clipped name never reads
// as a whole one.
const clip = (label: string, most: number): string =>
  cellWidth(label) <= most
    ? label
    : most <= 1
      ? label.slice(0, most)
      : `${label.slice(0, most - 1)}…`;

// A row's width with every label cut to `most`: each block is its label with
// one space either side, and blocks touch like neighbouring bar cells.
const rowWidth = (row: readonly PreviewSegment[], most: number): number =>
  row.reduce(
    (sum, { name }) => sum + Math.min(cellWidth(blockLabel(name)), most) + 2,
    0,
  );

// [LAW:dataflow-not-control-flow] Scaling is ONE number for the whole preview —
// the longest a label may be — so every row is cut alike and blocks stay
// comparable across rows: the largest length at which every row fits, down to
// one column. A row too long even then keeps its blocks in order while they fit.
export function labelBudget(rows: PreviewRows, available: number): number {
  const longest = Math.max(
    1,
    ...rows.flat().map(({ name }) => cellWidth(blockLabel(name))),
  );
  let most = longest;
  while (most > 1 && rows.some((row) => rowWidth(row, most) > available)) {
    most -= 1;
  }
  return most;
}

export function renderLayoutPreview(
  rows: PreviewRows,
  drawnAt: ColorDepth,
  available: number,
): RichText {
  const most = labelBudget(rows, available);
  const lines = rows.map((row) => {
    const blocks: RichText[] = [];
    let width = 0;
    for (const { name, address, palette } of row) {
      const block = new RichText(` ${clip(blockLabel(name), most)} `, {
        style: stateCell(
          palette,
          decorationFor(palette, { kind: "bar", address }).tint,
          drawnAt,
        ),
      });
      width += block.cellLength;
      if (width > available) break;
      blocks.push(block);
    }
    return blocks;
  });
  // Rows are the segment's own lines: the walk splits a segment's "\n" into
  // lines, and an open body leads each with its ✕.
  const preview = RichText.fromFragments(
    lines.flatMap((blocks, i) =>
      i === 0 ? blocks : [new RichText("\n"), ...blocks],
    ),
  );
  preview.noWrap = true;
  preview.end = "";
  return preview;
}

export function layoutPreviewFuncs(
  runtime: ActionRuntime,
  activeSegment: ActiveSegmentRef,
): FuncMap {
  return {
    layoutPreview: {
      fn: () =>
        renderLayoutPreview(
          runtime.layout(),
          activeSegment.drawnAt(),
          ledRowBudget(runtime),
        ),
      argTypes: [],
      returnType: "T",
    },
  };
}
