// [LAW:behavior-not-structure] Tests assert observable output (visible
// text, total width, style fields at the boundaries) — never the internal
// shape of how the layout result was assembled.
//
// [LAW:types-are-the-program] applySegmentLayout returns the ONE strip item a
// segment line contributes (0 cells for an empty line, 1 otherwise). For
// "auto" width it collapses the cells with no resize; for fixed width it sizes
// that one cell exactly to `width`, with truncation/padding applied.
// Span-preserving across every op (OSC-8 links survive as interior spans).

import { Style, cellLen, RichText } from "@promptctl/rich-js";
import { createCcCandybarEngine } from "../src/template-engine/engine";
import { applySegmentLayout, evaluateWhen } from "../src/template-engine/layout";
import { resolvedStyle } from "../src/render/rich-theme.js";
// edgeStyle resolves a style name against the render's theme; none is named here.
const EDGE_OPTS = { maxWidth: 80 };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cell(text: string, style?: Style | string): RichText {
  return new RichText(text, { style, end: "", overflow: "ignore" });
}

// The strip items a layout lays out, for the tests that read only its text.
function laidText(
  ...args: Parameters<typeof applySegmentLayout>
): RichText[] {
  return applySegmentLayout(...args).map((c) => c.text);
}

function totalWidth(cells: readonly RichText[]): number {
  return cells.reduce((sum, c) => sum + cellLen(c.plain), 0);
}

function texts(cells: readonly RichText[]): string[] {
  return cells.map((c) => c.plain);
}

const autoOptions = {
  width: "auto" as const,
  justify: "left" as const,
  padding: 0,
  truncate: "right" as const,
};

// ────────────────────────────────────────────────────────────────────────────
// 1. evaluateWhen
// ────────────────────────────────────────────────────────────────────────────

describe("evaluateWhen", () => {
  const engine = createCcCandybarEngine();

  test("undefined template → always true", () => {
    expect(evaluateWhen(undefined, {})).toBe(true);
  });

  test("template evaluating to 'true' → true", () => {
    const t = engine.parse("{{ eq 1 1 }}");
    expect(evaluateWhen(t, {})).toBe(true);
  });

  test("template evaluating to 'false' → false", () => {
    const t = engine.parse("{{ eq 1 2 }}");
    expect(evaluateWhen(t, {})).toBe(false);
  });

  test("template literal 'false' string → false", () => {
    const t = engine.parse("false");
    expect(evaluateWhen(t, {})).toBe(false);
  });

  test("empty string template → true (not 'false')", () => {
    const t = engine.parse("");
    expect(evaluateWhen(t, {})).toBe(true);
  });

  test("non-empty non-'false' string → true", () => {
    const t = engine.parse("yes");
    expect(evaluateWhen(t, {})).toBe(true);
  });

  test("field-based predicate: branch not empty → true", () => {
    const t = engine.parse('{{ ne .branch "" }}');
    expect(evaluateWhen(t, { branch: "main" })).toBe(true);
    expect(evaluateWhen(t, { branch: "" })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Auto width — cells collapse into one strip item (no resize)
// ────────────────────────────────────────────────────────────────────────────

describe("auto width — collapse to one cell, no width constraint", () => {
  test("collapses the segment's cells into one strip item", () => {
    const cells = [cell("hello"), cell(" world")];
    const result = laidText(cells, autoOptions);
    expect(result).toHaveLength(1);
    expect(texts(result)).toEqual(["hello world"]);
  });

  test("empty input returns empty (a unit that rendered nothing has no item)", () => {
    expect(laidText([], autoOptions)).toHaveLength(0);
  });
});

// A fill width is content-sized here and carries its demand to the row
// (src/render/fill.ts) as a field of the laid cell; no other width does.
describe("fill width — content-sized, carrying its demand", () => {
  const sizing = { justify: "right", truncate: "middle", padding: 0 } as const;

  test("fill states its demand with the sizing the row will honour", () => {
    const [laid] = applySegmentLayout([cell("hi")], { ...sizing, width: "fill" });
    expect(laid!.text.plain).toBe("hi");
    expect(laid!.fill).toEqual({
      justify: "right",
      truncate: "middle",
    });
  });

  test.each(["auto", 5] as const)("width %p states no demand", (width) => {
    const [laid] = applySegmentLayout([cell("hi")], { ...sizing, width });
    expect(laid!.fill).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2b. Padding — brandon-display-dam.2: intra-cell spaces from globals.padding
// ────────────────────────────────────────────────────────────────────────────

describe("padding — synthesized inside the collapsed cell, before sizing", () => {
  test("pads the collapsed cell on both sides", () => {
    const result = laidText([cell("hi")], {
      ...autoOptions,
      padding: 2,
    });
    expect(texts(result)).toEqual(["  hi  "]);
  });

  test("padding sits INSIDE a fixed width (pad first, then size)", () => {
    const result = laidText([cell("hi")], {
      width: 8,
      justify: "left",
      truncate: "right",
      padding: 1,
    });
    expect(texts(result)).toEqual([" hi     "]);
    expect(totalWidth(result)).toBe(8);
  });

  test("empty input stays empty regardless of padding (no phantom pill)", () => {
    expect(
      laidText([], { ...autoOptions, padding: 2 }),
    ).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Fixed width — exact fit
// ────────────────────────────────────────────────────────────────────────────

describe("fixed width — exact fit", () => {
  test("content already fills the width", () => {
    const result = laidText([cell("hello")], {
      width: 5,
      justify: "left",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result.map((c) => c.plain).join("")).toBe("hello");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Justify
// ────────────────────────────────────────────────────────────────────────────

describe("justify — left", () => {
  test("pads on the right to reach width", () => {
    const result = laidText([cell("hi")], {
      width: 5,
      justify: "left",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result[0]!.plain).toBe("hi   ");
  });
});

describe("justify — right", () => {
  test("pads on the left to reach width", () => {
    const result = laidText([cell("hi")], {
      width: 5,
      justify: "right",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result[0]!.plain).toBe("   hi");
  });
});

describe("justify — center", () => {
  test("pads on both sides; smaller half on left when odd", () => {
    const result = laidText([cell("hi")], {
      width: 6,
      justify: "center",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("  hi  ");
  });

  test("center odd: left pad gets smaller half", () => {
    const result = laidText([cell("hi")], {
      width: 5,
      justify: "center",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result[0]!.plain).toBe(" hi  ");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Truncate — right (marker "…")
// ────────────────────────────────────────────────────────────────────────────

describe("truncate — right", () => {
  test("keeps left, marker on right", () => {
    const result = laidText([cell("hello world")], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("hello…");
  });
});

describe("truncate — left", () => {
  test("marker on left, keeps right", () => {
    const result = laidText([cell("hello world")], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "left",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("…world");
  });
});

describe("truncate — middle", () => {
  test("keeps halves; marker in the middle", () => {
    const result = laidText([cell("hello world!")], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "middle",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("he…ld!");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Multi-cell truncation
// ────────────────────────────────────────────────────────────────────────────

describe("multi-cell truncation", () => {
  test("cells are concatenated before layout; result is one cell", () => {
    const cells = [cell("hello"), cell(" world"), cell("!!")];
    const result = laidText(cells, {
      width: 8,
      justify: "left",
      padding: 0,
      truncate: "right",
    });
    expect(result).toHaveLength(1);
    expect(totalWidth(result)).toBe(8);
    expect(result[0]!.plain).toBe("hello w…");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. baseStyle on the merged cell
// ────────────────────────────────────────────────────────────────────────────

describe("baseStyle on the merged cell", () => {
  test("padding inherits the cell's wrapping style (segment bg+fg continuous)", () => {
    const baseStyle = new Style({ bgcolor: "blue", color: "white" });
    const result = laidText([cell("hi", baseStyle)], {
      width: 5,
      justify: "left",
      padding: 0,
      truncate: "right",
      baseStyle,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.plain).toBe("hi   ");
    // The cell-level style is the baseStyle, so padding chars (which have
    // no span overlay) render with that style — making the segment bg+fg
    // continuous across the padded gap.
    expect(resolvedStyle(result[0]!.style).bgcolor?.name).toBe("blue");
    expect(resolvedStyle(result[0]!.style).color?.name).toBe("white");
    // Edges report the same baseStyle since the kept text fragment carries
    // the same merged style.
    expect(result[0]!.edgeStyle("left", EDGE_OPTS).bgcolor?.name).toBe("blue");
    expect(result[0]!.edgeStyle("right", EDGE_OPTS).bgcolor?.name).toBe("blue");
  });

  test("truncation marker rides on the cell's wrapping style", () => {
    const baseStyle = new Style({ bgcolor: "blue", color: "white" });
    const result = laidText([cell("hello world", baseStyle)], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "right",
      baseStyle,
    });
    expect(result[0]!.plain).toBe("hello…");
    expect(resolvedStyle(result[0]!.style).bgcolor?.name).toBe("blue");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. Truncation through heterogeneous-fg interior — bzh.9 limitation is gone
// ────────────────────────────────────────────────────────────────────────────
// [LAW:types-are-the-program] With RichText as the cell type, truncation
// preserves spans by construction. The bzh.9 "parts-based cell loses per-
// part fg through a cut" limitation cannot be expressed in this shape —
// the slice path is RichText.truncate, which clips spans through the cut.

describe("truncation preserves per-character styling through the cut", () => {
  function heterogeneousCell(): RichText {
    const r = new RichText("hello world", {
      style: new Style({ bgcolor: "blue", color: "white" }),
      end: "",
      overflow: "ignore",
    });
    r.stylize("red", 6, 11); // "world" is red
    return r;
  }

  test("right truncation keeps the spans that survive the cut", () => {
    const cell = heterogeneousCell();
    const result = laidText([cell], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "right",
    });
    expect(result[0]!.plain).toBe("hello…");
    // The "world" span was at chars 6..11; after truncation to width 6
    // (keeping 5 chars + marker), all of "world" is dropped, so no red
    // span survives — but the kept text retains its base styling. Assert the
    // rendered edge colour (what the joiner reads), not where it is stored:
    // the collapsed cell carries the base bg as a span, not as wrapping style.
    expect(result[0]!.edgeStyle("left", EDGE_OPTS).bgcolor?.name).toBe("blue");
  });

  test("left truncation keeps the right side spans", () => {
    const cell = heterogeneousCell();
    const result = laidText([cell], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "left",
    });
    expect(result[0]!.plain).toBe("…world");
    // The "world" span survives intact on the right.
    const spans = result[0]!.spans;
    const redSpan = spans.find((s) =>
      resolvedStyle(s.style).color?.name === "red",
    );
    expect(redSpan).toBeDefined();
    expect(result[0]!.plain.slice(redSpan!.start, redSpan!.end)).toBe("world");
  });
});
