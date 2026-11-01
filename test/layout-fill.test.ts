// [LAW:behavior-not-structure] `width: "fill"` (brandon-layout-0c2): a segment takes
// what is left of its row. The claim is about DRAWN COLUMNS — what the terminal
// shows — not about which function computed the share, so every assertion here
// measures the rendered line.
//
// The first test is where the ticket's risk lives. The leftover depends on what the
// joiner chrome costs, and that differs per style — measured through this very
// serializer, powerline and capsule cost their caps and seams, and plain's cost
// is the author's own separator text — so the resolution
// MEASURES the row instead of modelling any of it, and this test pins the result
// over every endcaps shape, the same shape as the measured-chrome pin
// in test/picker-pagination.test.ts.
//
// Two wrong answers were caught here rather than shipped: reserving
// `stripChromeCols` (right for the picker's pagination seam, wrong here — the
// measurement already carries the chrome, so reserving it again left every row a
// column short), and measuring the row with the fill cell emptied to zero width,
// which makes FlexStrip FOLD THE LINE at the empty cell and report the width of the
// first fragment instead of the row.

import { drawPayload } from "./helpers/draw-payload";
import { plainOf, textOf } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import {
  DEFAULT_TERMINAL_THEME,
  cellLen,
  RichText,
  Style,
} from "@promptctl/rich-js";

import { fitRow } from "../src/render/fill";
import { drawStripCells } from "../src/render/strip";
import type { CellSizing, LaidCell } from "../src/template-engine/layout";
import type { BuildLineOptions } from "../src/render/strip";
import {
  listResolvablePaletteNames,
  ENDCAPS_SHAPES,
} from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { instantOf } from "../src/utils/instant";

const SIZING: CellSizing = {
  justify: "left",
  truncate: "right",
};

function opts(over: Partial<BuildLineOptions> = {}): BuildLineOptions {
  return {
    endcaps: "powerline",
    width: 40,
    wrap: true,
    colorCompatibility: "none",
    padding: 0,
    ...over,
  } as BuildLineOptions;
}

// A cell is never a line: every producer builds it with `end: ""`, the strip
// ending the row. A default `end` ("\n") would break the row after each cell.
const fixed = (text: string): LaidCell => ({
  text: new RichText(text, { end: "" }),
  placement: {
    id: text,
    effect: "bar",
    ground: DEFAULT_TERMINAL_THEME.backgroundColor,
  },
});
const fill = (text: string): LaidCell => ({ ...fixed(text), fill: SIZING });

function serialize(
  cells: readonly LaidCell[],
  options: BuildLineOptions,
): string[] {
  return drawStripCells(
    fitRow(cells, options).map((item) => item.owner),
    options,
  ).lines.map(plainOf);
}

describe("a fill segment absorbs the row's leftover width", () => {
  // The product pin: whatever the chrome costs, the row lands on the width.
  test.each(ENDCAPS_SHAPES.map((style) => [style] as const))(
    "%s: the row serializes to exactly the available width",
    (style) => {
      for (const width of [30, 40, 67]) {
        const lines = serialize(
          [fixed("left"), fill("mid"), fixed("right")],
          opts({ endcaps: style, width }),
        );
        expect({
          style,
          width,
          lines: lines.length,
          cols: cellLen(lines[0]!),
        }).toEqual({ style, width, lines: 1, cols: width });
      }
    },
  );

  test("the fill cell grows, and every other cell keeps its natural width", () => {
    const before = [fixed("left"), fill("mid"), fixed("right")];
    const natural = before.map((c) => c.text.cellLength);
    const lines = serialize(before, opts({ width: 40 }));
    expect(lines).toHaveLength(1);
    // The fixed cells are untouched; only the marked one moved.
    expect(before[0]!.text.cellLength).toBe(natural[0]);
    expect(before[2]!.text.cellLength).toBe(natural[2]);
    expect(before[1]!.text.cellLength).toBeGreaterThan(natural[1]!);
  });

  // Two fills split the remainder, and the row still lands exactly — the
  // remainder goes to the last one rather than being lost a column at a time.
  test("two fills split the leftover and the row still lands on the width", () => {
    for (const width of [31, 32, 33]) {
      const cells = [fixed("a"), fill("x"), fixed("b"), fill("y")];
      const lines = serialize(cells, opts({ width }));
      expect(cellLen(lines[0]!)).toBe(width);
      const [, first, , second] = cells;
      // Split evenly to within the one-column remainder.
      expect(
        Math.abs(first!.text.cellLength - second!.text.cellLength),
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
    const natural = cell.text.cellLength;
    const withFill = serialize([fixed(long), cell], opts({ width: 20 }));
    expect(cell.text.cellLength).toBe(natural);
    for (const line of withFill) expect(cellLen(line)).toBeLessThanOrEqual(20);
  });

  // The case that actually discriminates, found by a mutation that did NOT bite:
  // with the wrap guard removed, the row above still passed, because its first
  // line happened to be exactly full so the measured deficit was zero anyway. A
  // row whose first line is SHORT of the width is the one that catches it — there
  // the deficit looks positive while the row is already overflowing, and a fill
  // grown by it would widen a row that has no room at all.
  test("a row that wraps SHORT of the width still hands the fill nothing", () => {
    const cell = fill("m");
    const natural = cell.text.cellLength;
    const lines = serialize(
      [fixed("x".repeat(15)), fixed("y".repeat(15)), cell],
      opts({ width: 20 }),
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(cellLen(lines[0]!)).toBeLessThan(20);
    expect(cell.text.cellLength).toBe(natural);
    for (const line of lines) expect(cellLen(line)).toBeLessThanOrEqual(20);
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
    const natural = cell.text.cellLength;
    fitRow(
      [fixed("left"), cell],
      opts({ width: Number.POSITIVE_INFINITY }),
    );
    expect(cell.text.cellLength).toBe(natural);
  });

  test("a row with no fill serializes its cells untouched", () => {
    const cells = [fixed("left"), fixed("right")];
    const out = fitRow(cells, opts());
    cells.forEach((c, i) => expect(out[i]!.owner).toBe(c.text));
  });
});

// A row breaks only between strip items, so a cell wider than a line reaches the
// strip as several. Everything here is read off the drawn lines: no line past
// the width, and no text of the cell gone, whitespace and strip caps aside.
describe("a cell wider than a line wraps across lines", () => {
  const SENTENCE =
    " alpha bravo bravo charlie 日本語のテキスト 🍫🍫 delta-echo-foxtrot-golf-hotel-india-juliet-kilo ▸ ";
  const squeezed = (s: string): string => s.replace(/[\s\uE000-\uF8FF]/gu, "");
  const painted = (text: string): LaidCell => ({
    ...fixed(text),
    text: new RichText(text, {
      end: "",
      overflow: "ignore",
      style: new Style({ bgcolor: "#445566", color: "#ffffff" }),
    }),
  });

  describe.each(ENDCAPS_SHAPES.map((style) => [style] as const))("%s", (endcaps) => {
    test.each([[10], [20], [30], [67]])("draws within width %i", (width) => {
      for (const cell of [painted(SENTENCE), fixed(SENTENCE)]) {
        const lines = serialize([cell], opts({ endcaps, width }));
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.filter((line) => cellLen(line) > width)).toEqual([]);
        expect(squeezed(lines.join(""))).toBe(squeezed(SENTENCE));
      }
    });
  });

  test("its lead and trail wrap with it", () => {
    const lines = serialize(
      [
        {
          ...painted(SENTENCE),
          lead: new RichText(" ✕", { end: "" }),
          trail: new RichText("🔧 ", { end: "" }),
        },
      ],
      opts({ width: 30 }),
    );
    expect(lines.filter((line) => cellLen(line) > 30)).toEqual([]);
    expect(squeezed(lines.join(""))).toBe(squeezed(`✕${SENTENCE}🔧`));
  });

  test("a control's link stays on the control, and every piece keeps the cell's ground", () => {
    const cell = painted(SENTENCE);
    const at = SENTENCE.indexOf("▸");
    const link = new Style({ link: "cc-candybar://arrow" });
    cell.text.stylize(link, at, at + 1);
    const items = fitRow([cell], opts({ width: 30 }));
    const holding = items.filter(({ owner }) =>
      owner.spans.some(({ style }) => style === link),
    );
    expect(holding.map(({ owner }) => owner.plain)).toEqual([
      expect.stringContaining("▸"),
    ]);
    items.forEach(({ owner, placement }) => {
      expect(owner.style).toBe(cell.text.style);
      expect(placement).toBe(cell.placement);
    });
  });

  test("a tab's words survive: rich-js expands it before it wraps", () => {
    const text = " one two\tthree four five six seven eight nine ten ";
    const lines = serialize([painted(text)], opts({ width: 30 }));
    expect(lines.filter((line) => cellLen(line) > 30)).toEqual([]);
    expect(squeezed(lines.join(""))).toBe(squeezed(text));
  });

  test("a full-width space left hanging at a break costs no text", () => {
    const text = "日本語の説明\u3000次の見出し\u3000最後の行まで続く文章 ▸";
    for (const width of [9, 10, 11, 12, 13, 20, 30]) {
      for (const endcaps of ENDCAPS_SHAPES) {
        const lines = serialize([painted(text)], opts({ endcaps, width }));
        expect(lines.filter((line) => cellLen(line) > width)).toEqual([]);
        expect(squeezed(lines.join(""))).toBe(squeezed(text));
      }
    }
  });

  test("a word wider than a line folds through it", () => {
    const word = "x".repeat(100);
    const lines = serialize([painted(word)], opts({ width: 30 }));
    expect(lines.filter((line) => cellLen(line) > 30)).toEqual([]);
    expect(squeezed(lines.join(""))).toBe(word);
  });

  test("a cell of spaces draws a line of them, never a zero-width item", () => {
    const items = fitRow([painted(" ".repeat(100))], opts({ width: 30 }));
    expect(items.map(({ owner }) => owner.cellLength)).toEqual([28]);
  });

  test("an unpainted cell that fits as drawn stays whole", () => {
    const cell = fixed("x".repeat(29));
    const [only, ...rest] = fitRow([cell], opts({ width: 30 }));
    expect(only!.owner).toBe(cell.text);
    expect(rest).toEqual([]);
  });

  test("a spacer pushes its neighbour flush to an unpainted row's edge", () => {
    const lines = serialize(
      [{ ...fixed(" "), fill: SIZING }, fixed("▸")],
      opts({ width: 30 }),
    );
    expect(lines.map((line) => cellLen(line))).toEqual([30]);
  });

  test("a cell painted only at its head keeps the line it fits", () => {
    const cell = fixed(`z yyyyyyy ${"x".repeat(19)}`);
    cell.text.stylize(new Style({ bgcolor: "#445566" }), 0, 1);
    const [only, ...rest] = fitRow([cell], opts({ width: 30 }));
    expect(only!.owner).toBe(cell.text);
    expect(rest).toEqual([]);
  });

  test.each([["right"], ["center"]] as const)(
    "padding %s of a cell spends no row on itself",
    (justify) => {
      const cell = painted("abc");
      cell.text.align(justify, 100);
      const lines = serialize([cell], opts({ width: 30 }));
      expect(lines.map(squeezed)).toEqual(["abc"]);
    },
  );

  test("a fill cell too wide for a line divides and is given nothing", () => {
    const cell = { ...painted(SENTENCE), fill: SIZING };
    const natural = cell.text.cellLength;
    const lines = serialize([cell], opts({ width: 30 }));
    expect(cell.text.cellLength).toBe(natural);
    expect(lines.filter((line) => cellLen(line) > 30)).toEqual([]);
  });

  test("a row that may not wrap keeps the cell whole", () => {
    const cell = painted(SENTENCE);
    const [only, ...rest] = fitRow([cell], opts({ width: 30, wrap: false }));
    expect(only!.owner).toBe(cell.text);
    expect(rest).toEqual([]);
  });

  test("an unbounded width keeps the cell whole", () => {
    const cell = painted(SENTENCE);
    const [only, ...rest] = fitRow(
      [cell],
      opts({ width: Number.POSITIVE_INFINITY }),
    );
    expect(only!.owner).toBe(cell.text);
    expect(rest).toEqual([]);
  });
});

// brandon-render-channels-b1x.2fs — the demand is a field of the laid cell, so it
// reaches the row through every way the walk rebuilds a line: zipped into a
// horizontal container's row, and copied into a new line behind the ✕ an open
// disclosure body's rows are led with. Measured on the frame `drawDsl` draws,
// the one render path, rather than on the cells it composes.
describe("a fill segment fills wherever the walk places it", () => {
  const WIDTH = 60;
  const render = (root: string): string[] => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        segments: {
          a: { template: 'A' },
          b: { template: 'B' },
          wide: { template: 'fill', width: 'fill' },
        },
        root: ${root},
      }`,
      new Set(listResolvablePaletteNames()),
    );
    const store = new VariableStore();
    const registry = new SourceRegistry(
      processLauncher,
      store,
      "",
      new SessionState(),
    );
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
    const errors: string[] = [];
    const out = drawPayload(
      config,
      compiled,
      store,
      registry,
      { session_id: "s1" },
      instantOf(new Date()),
      opts({ width: WIDTH, padding: 1 }),
      { onSegmentError: (n, m) => errors.push(`${n}: ${m}`) },
    ).frame;
    registry.dispose();
    expect(errors).toEqual([]);
    return textOf(out).split("\n");
  };
  const filled = (lines: string[]) =>
    lines
      .filter((l) => l.includes("fill"))
      .map((l) => ({ line: l, cols: cellLen(l) }));

  test("in a horizontal row", () => {
    const rows = filled(render(`{ h: ['a', 'wide', 'b'] }`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cols).toBe(WIDTH);
  });

  test("in an open disclosure body row led by its ✕", () => {
    const lines = render(
      `{ v: [{ kind: 'group', name: 'g', label: 'G', open: true, children: [{ h: ['a', 'wide'] }] }] }`,
    );
    const rows = filled(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.line).toContain("✕");
    expect(rows[0]!.cols).toBe(WIDTH);
  });
});
