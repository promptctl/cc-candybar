// [LAW:behavior-not-structure] Tests assert observable output (visible
// text, total width, style fields at the boundaries) — never the internal
// shape of how the layout result was assembled.
//
// [LAW:types-are-the-program] applySegmentLayout returns RichText[]. For
// "auto" width it passes the input through; for fixed width it produces
// one merged RichText sized exactly to `width`, with truncation/padding
// already applied. Span-preserving across every op.

import { Style, cellLen, RichText } from "@promptctl/rich-js";
import { createCcCandybarEngine } from "../src/template-engine/engine";
import { applySegmentLayout, evaluateWhen } from "../src/template-engine/layout";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cell(text: string, style?: Style | string): RichText {
  return new RichText(text, { style, end: "", noWrap: true });
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
// 2. Auto width — cells pass through
// ────────────────────────────────────────────────────────────────────────────

describe("auto width — no layout constraint applied", () => {
  test("returns cells unchanged", () => {
    const cells = [cell("hello"), cell(" world")];
    const result = applySegmentLayout(cells, autoOptions);
    expect(texts(result)).toEqual(["hello", " world"]);
  });

  test("empty input returns empty", () => {
    expect(applySegmentLayout([], autoOptions)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Fixed width — exact fit
// ────────────────────────────────────────────────────────────────────────────

describe("fixed width — exact fit", () => {
  test("content already fills the width", () => {
    const result = applySegmentLayout([cell("hello")], {
      width: 5,
      justify: "left",
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
    const result = applySegmentLayout([cell("hi")], {
      width: 5,
      justify: "left",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result[0]!.plain).toBe("hi   ");
  });
});

describe("justify — right", () => {
  test("pads on the left to reach width", () => {
    const result = applySegmentLayout([cell("hi")], {
      width: 5,
      justify: "right",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result[0]!.plain).toBe("   hi");
  });
});

describe("justify — center", () => {
  test("pads on both sides; smaller half on left when odd", () => {
    const result = applySegmentLayout([cell("hi")], {
      width: 6,
      justify: "center",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("  hi  ");
  });

  test("center odd: left pad gets smaller half", () => {
    const result = applySegmentLayout([cell("hi")], {
      width: 5,
      justify: "center",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result[0]!.plain).toBe(" hi  ");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Truncate — right (default marker "…")
// ────────────────────────────────────────────────────────────────────────────

describe("truncate — right", () => {
  test("keeps left, marker on right", () => {
    const result = applySegmentLayout([cell("hello world")], {
      width: 6,
      justify: "left",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("hello…");
  });
});

describe("truncate — left", () => {
  test("marker on left, keeps right", () => {
    const result = applySegmentLayout([cell("hello world")], {
      width: 6,
      justify: "left",
      truncate: "left",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("…world");
  });
});

describe("truncate — middle", () => {
  test("keeps halves; marker in the middle", () => {
    const result = applySegmentLayout([cell("hello world!")], {
      width: 6,
      justify: "left",
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
    const result = applySegmentLayout(cells, {
      width: 8,
      justify: "left",
      truncate: "right",
    });
    expect(result).toHaveLength(1);
    expect(totalWidth(result)).toBe(8);
    expect(result[0]!.plain).toBe("hello w…");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Custom marker
// ────────────────────────────────────────────────────────────────────────────

describe("custom truncate marker", () => {
  test("two-char marker on right", () => {
    const result = applySegmentLayout([cell("hello world")], {
      width: 7,
      justify: "left",
      truncate: "right",
      truncateMarker: ">>",
    });
    expect(result[0]!.plain).toBe("hello>>");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. baseStyle on the merged cell
// ────────────────────────────────────────────────────────────────────────────

describe("baseStyle on the merged cell", () => {
  test("padding inherits the cell's wrapping style (segment bg+fg continuous)", () => {
    const baseStyle = new Style({ bgcolor: "blue", color: "white" });
    const result = applySegmentLayout([cell("hi", baseStyle)], {
      width: 5,
      justify: "left",
      truncate: "right",
      baseStyle,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.plain).toBe("hi   ");
    // The cell-level style is the baseStyle, so padding chars (which have
    // no span overlay) render with that style — making the segment bg+fg
    // continuous across the padded gap.
    expect(result[0]!.style.bgcolor?.name).toBe("blue");
    expect(result[0]!.style.color?.name).toBe("white");
    // Edges report the same baseStyle since the kept text fragment carries
    // the same merged style.
    expect(result[0]!.edgeStyle("left").bgcolor?.name).toBe("blue");
    expect(result[0]!.edgeStyle("right").bgcolor?.name).toBe("blue");
  });

  test("truncation marker rides on the cell's wrapping style", () => {
    const baseStyle = new Style({ bgcolor: "blue", color: "white" });
    const result = applySegmentLayout([cell("hello world", baseStyle)], {
      width: 6,
      justify: "left",
      truncate: "right",
      baseStyle,
    });
    expect(result[0]!.plain).toBe("hello…");
    expect(result[0]!.style.bgcolor?.name).toBe("blue");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 9. Truncation through heterogeneous-fg interior — bzh.9 limitation is gone
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
      noWrap: true,
    });
    r.stylize("red", 6, 11); // "world" is red
    return r;
  }

  test("right truncation keeps the spans that survive the cut", () => {
    const cell = heterogeneousCell();
    const result = applySegmentLayout([cell], {
      width: 6,
      justify: "left",
      truncate: "right",
    });
    expect(result[0]!.plain).toBe("hello…");
    // The "world" span was at chars 6..11; after truncation to width 6
    // (keeping 5 chars + marker), all of "world" is dropped, so no red
    // span survives — but the kept text retains its base styling.
    expect(result[0]!.style.bgcolor?.name).toBe("blue");
  });

  test("left truncation keeps the right side spans", () => {
    const cell = heterogeneousCell();
    const result = applySegmentLayout([cell], {
      width: 6,
      justify: "left",
      truncate: "left",
    });
    expect(result[0]!.plain).toBe("…world");
    // The "world" span survives intact on the right.
    const spans = result[0]!.spans;
    const redSpan = spans.find((s) =>
      typeof s.style === "string"
        ? s.style.includes("red")
        : s.style.color?.name === "red",
    );
    expect(redSpan).toBeDefined();
    expect(result[0]!.plain.slice(redSpan!.start, redSpan!.end)).toBe("world");
  });
});
