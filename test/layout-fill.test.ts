// [LAW:behavior-not-structure] `width: "fill"` (brandon-layout-0c2): a segment takes
// what is left of its row. The claim is about SERIALIZED COLUMNS — what the terminal
// receives — not about which function computed the share, so every assertion here
// measures the rendered line.
//
// The first test is where the ticket's risk lives. The leftover depends on what the
// joiner chrome costs, and that differs per style — measured through this very
// serializer, powerline costs nothing inside the width budget, capsule costs per
// seam, and plain's cost is the author's own separator text — so the resolution
// MEASURES the row instead of modelling any of it, and this test pins the result
// over the whole style × charset product, the same shape as the measured-chrome pin
// in test/picker-pagination.test.ts.
//
// Two wrong answers were caught here rather than shipped: reserving
// `stripChromeCols` (right for the picker's pagination seam, wrong here — the
// measurement already carries the chrome, so reserving it again left every row a
// column short), and measuring the row with the fill cell emptied to zero width,
// which makes FlexStrip FOLD THE LINE at the empty cell and report the width of the
// first fragment instead of the row.

import { cellLen, RichText } from "@promptctl/rich-js";

import { resolveFill } from "../src/render/fill";
import { renderStripCells } from "../src/render/strip";
import { markFill, type CellSizing } from "../src/template-engine/layout";
import type { BuildLineOptions } from "../src/render/strip";
import { CHARSETS, STRIP_STYLES } from "../src/themes/policy";

// eslint-disable-next-line no-control-regex
const INVISIBLE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x1b\\|\x07)/g;
const cols = (line: string): number => cellLen(line.replace(INVISIBLE, ""));

const SIZING: CellSizing = {
  justify: "left",
  truncate: "right",
  truncateMarker: "…",
};

function opts(over: Partial<BuildLineOptions> = {}): BuildLineOptions {
  return {
    style: "powerline",
    charset: "unicode",
    width: 40,
    wrap: true,
    colorCompatibility: "none",
    padding: 0,
    ...over,
  } as BuildLineOptions;
}

const fixed = (text: string): RichText => new RichText(text);
const fill = (text: string): RichText => markFill(new RichText(text), SIZING);

function serialize(
  cells: readonly RichText[],
  options: BuildLineOptions,
): string[] {
  return renderStripCells(resolveFill(cells, options), options).split("\n");
}

describe("a fill segment absorbs the row's leftover width", () => {
  // The product pin: whatever the chrome costs, the row lands on the width.
  test.each(
    STRIP_STYLES.flatMap((style) =>
      CHARSETS.map((charset) => [style, charset] as const),
    ),
  )(
    "%s/%s: the row serializes to exactly the available width",
    (style, charset) => {
      for (const width of [30, 40, 67]) {
        const lines = serialize(
          [fixed("left"), fill("mid"), fixed("right")],
          opts({ style, charset, width }),
        );
        expect({
          style,
          charset,
          width,
          lines: lines.length,
          cols: cols(lines[0]!),
        }).toEqual({ style, charset, width, lines: 1, cols: width });
      }
    },
  );

  test("the fill cell grows, and every other cell keeps its natural width", () => {
    const before = [fixed("left"), fill("mid"), fixed("right")];
    const natural = before.map((c) => c.cellLength);
    const lines = serialize(before, opts({ width: 40 }));
    expect(lines).toHaveLength(1);
    // The fixed cells are untouched; only the marked one moved.
    expect(before[0]!.cellLength).toBe(natural[0]);
    expect(before[2]!.cellLength).toBe(natural[2]);
    expect(before[1]!.cellLength).toBeGreaterThan(natural[1]!);
  });

  // Two fills split the remainder, and the row still lands exactly — the
  // remainder goes to the last one rather than being lost a column at a time.
  test("two fills split the leftover and the row still lands on the width", () => {
    for (const width of [31, 32, 33]) {
      const cells = [fixed("a"), fill("x"), fixed("b"), fill("y")];
      const lines = serialize(cells, opts({ width }));
      expect(cols(lines[0]!)).toBe(width);
      const [, first, , second] = cells;
      // Split evenly to within the one-column remainder.
      expect(
        Math.abs(first!.cellLength - second!.cellLength),
      ).toBeLessThanOrEqual(1);
    }
  });

  // [LAW:no-silent-failure] A fill must never make a row WIDER than the width it
  // was given. When the row already overflows there is nothing to hand out: the
  // fill keeps its natural content — shrinking it to nothing would delete what the
  // author wrote to make room for slack that does not exist — and the strip's own
  // wrap owns the overflow exactly as it did before this existed.
  test("an already-full row hands the fill nothing and wraps as before", () => {
    const long = "x".repeat(50);
    const cell = fill("mid");
    const natural = cell.cellLength;
    const withFill = serialize([fixed(long), cell], opts({ width: 20 }));
    expect(cell.cellLength).toBe(natural);
    for (const line of withFill) expect(cols(line)).toBeLessThanOrEqual(20);
  });

  // The case that actually discriminates, found by a mutation that did NOT bite:
  // with the wrap guard removed, the row above still passed, because its first
  // line happened to be exactly full so the measured deficit was zero anyway. A
  // row whose first line is SHORT of the width is the one that catches it — there
  // the deficit looks positive while the row is already overflowing, and a fill
  // grown by it would widen a row that has no room at all.
  test("a row that wraps SHORT of the width still hands the fill nothing", () => {
    const cell = fill("m");
    const natural = cell.cellLength;
    const lines = serialize(
      [fixed("x".repeat(15)), fixed("y".repeat(15)), cell],
      opts({ width: 20 }),
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(cols(lines[0]!)).toBeLessThan(20);
    expect(cell.cellLength).toBe(natural);
    for (const line of lines) expect(cols(line)).toBeLessThanOrEqual(20);
  });

  // An unbounded row has no "rest of it", and `globals.autoWrap: false` renders at
  // exactly that width, so this is a production value and not a theoretical one.
  //
  // A PINNED LIMIT, not a claim: no assertion here can distinguish the guard from
  // its absence today, because `align(justify, Infinity)` happens to be a no-op in
  // rich-js — a mutation removing the guard changes nothing observable. The guard
  // stays because the intent must not rest on that accident; if align ever throws
  // or pads unboundedly, this test starts failing and the guard is what it wanted.
  test("an unbounded width leaves the cell content-sized", () => {
    const cell = fill("mid");
    const natural = cell.cellLength;
    resolveFill(
      [fixed("left"), cell],
      opts({ width: Number.POSITIVE_INFINITY }),
    );
    expect(cell.cellLength).toBe(natural);
  });

  test("a row with no fill is returned untouched", () => {
    const cells = [fixed("left"), fixed("right")];
    expect(resolveFill(cells, opts())).toBe(cells);
  });
});
