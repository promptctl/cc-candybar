// A gauge: ONE value against a fixed maximum (brandon-template-funcs-zv5).
//
// The sparkline beside this file measures the other thing — shape over time,
// normalised against its own window's min/max — and the two stay separate
// functions because they answer different questions. A gauge normalises against a
// maximum the author states, so "73 % of the context window" reads the same at
// every moment, which is exactly what a sparkline cannot say.
//
// [LAW:effects-at-boundaries] Pure: numbers, glyphs, and a colour-per-position
// callback in; one RichText out. No clock, no store, nothing accumulated, and no
// palette — resolving a colour is the binding's job (src/render/segment-color.ts),
// which is where the active segment's palette lives.

import { RichText, Style } from "@promptctl/rich-js";

export interface GaugeSpec {
  readonly value: number;
  readonly max: number;
  // Cells, not columns of text: each cell is one glyph.
  readonly width: number;
  readonly filled: string;
  readonly empty: string;
  // The colour for a lit cell, asked at that CELL's own position in the value
  // domain — the whole point of the painted-cell form. Absent means monochrome:
  // every cell inherits the segment's own fg, like the sparkline.
  readonly colourAt?: (position: number) => string;
}

/**
 * Draw `value` against `max` as `width` cells.
 *
 * [LAW:dataflow-not-control-flow] Every cell is emitted; whether it is lit and
 * what colour it wears follow from its index. There is no "coloured gauge" mode —
 * `colourAt` is a value, and its absence is monochrome.
 */
export function renderGauge(spec: GaugeSpec): RichText {
  const { value, max, width, filled, empty, colourAt } = spec;
  const lit = litCells(value, max, width);
  const cells: RichText[] = [];
  for (let i = 0; i < width; i++) {
    const isLit = i < lit;
    // A cell's position is its LOWER edge in the value domain. Not its centre and
    // not its upper edge: under a `step` ramp with a threshold at 50 and ten cells
    // over 100, the cell covering [40, 50) must not already wear the threshold's
    // colour, and an upper edge would give it one.
    const hex =
      isLit && colourAt !== undefined ? colourAt((i * max) / width) : undefined;
    cells.push(
      new RichText(isLit ? filled : empty, {
        style: hex === undefined ? undefined : new Style({ color: hex }),
      }),
    );
  }
  const gauge = RichText.fromFragments(cells);
  gauge.end = "";
  gauge.noWrap = true;
  return gauge;
}

// [LAW:no-silent-failure] A non-finite or non-positive maximum has no gauge to
// draw — it would divide by zero or scale by a NaN and paint a plausible-looking
// bar from nonsense — so it reads as empty rather than as some number of cells.
// Rounding (not flooring) is what makes the drawn fraction the nearest one the
// cell count can express.
function litCells(value: number, max: number, width: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(width, Math.max(0, Math.round((value / max) * width)));
}
