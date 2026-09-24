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

// A block's label cut to `most` columns by the cell-aware truncation every
// sized cell uses, the cut marked so a clipped name never reads as a whole one.
const clippedLabel = (name: string, most: number): string => {
  const label = new RichText(blockLabel(name));
  label.truncate(most, { marker: "…" });
  return label.plain;
};

// [LAW:dataflow-not-control-flow] Scaling is ONE number for the whole preview —
// the longest a label may be — so every row is cut alike and blocks stay
// comparable across rows: the largest length at which every row fits, down to
// one column. A row too long even then keeps its blocks in order while they fit.
// Each label is measured once; a row's width at `most` is then arithmetic —
// every block is its label with one space either side, touching its neighbours
// like bar cells.
export function labelBudget(rows: PreviewRows, available: number): number {
  const widths = rows.map((row) =>
    row.map(({ name }) => cellWidth(blockLabel(name))),
  );
  const fits = (most: number): boolean =>
    widths.every(
      (row) =>
        row.reduce((sum, w) => sum + Math.min(w, most) + 2, 0) <= available,
    );
  let most = Math.max(1, ...widths.flat());
  while (most > 1 && !fits(most)) most -= 1;
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
      const block = new RichText(` ${clippedLabel(name, most)} `, {
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
