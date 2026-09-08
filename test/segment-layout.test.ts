// [LAW:behavior-not-structure] Asserts observable output, never how the layout
// result was assembled.
//
// [LAW:types-are-the-program] applySegmentLayout returns the ONE strip item a
// segment line contributes: 0 cells for an empty line, 1 otherwise.

import { Style, cellLen, RichText } from "@promptctl/rich-js";
import { createCcCandybarEngine } from "../src/template-engine/engine";
import { applySegmentLayout, evaluateWhen } from "../src/template-engine/layout";

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
  padding: 0,
  truncate: "right" as const,
};

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

describe("auto width — collapse to one cell, no width constraint", () => {
  test("collapses the segment's cells into one strip item", () => {
    const cells = [cell("hello"), cell(" world")];
    const result = applySegmentLayout(cells, autoOptions);
    expect(result).toHaveLength(1);
    expect(texts(result)).toEqual(["hello world"]);
  });

  test("empty input returns empty (a unit that rendered nothing has no item)", () => {
    expect(applySegmentLayout([], autoOptions)).toHaveLength(0);
  });
});

describe("padding — synthesized inside the collapsed cell, before sizing", () => {
  test("pads the collapsed cell on both sides", () => {
    const result = applySegmentLayout([cell("hi")], {
      ...autoOptions,
      padding: 2,
    });
    expect(texts(result)).toEqual(["  hi  "]);
  });

  test("padding sits INSIDE a fixed width (pad first, then size)", () => {
    const result = applySegmentLayout([cell("hi")], {
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
      applySegmentLayout([], { ...autoOptions, padding: 2 }),
    ).toHaveLength(0);
  });
});

describe("fixed width — exact fit", () => {
  test("content already fills the width", () => {
    const result = applySegmentLayout([cell("hello")], {
      width: 5,
      justify: "left",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result.map((c) => c.plain).join("")).toBe("hello");
  });
});

describe("justify — left", () => {
  test("pads on the right to reach width", () => {
    const result = applySegmentLayout([cell("hi")], {
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
    const result = applySegmentLayout([cell("hi")], {
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
    const result = applySegmentLayout([cell("hi")], {
      width: 6,
      justify: "center",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("  hi  ");
  });

  test("center odd: left pad gets smaller half", () => {
    const result = applySegmentLayout([cell("hi")], {
      width: 5,
      justify: "center",
      padding: 0,
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(result[0]!.plain).toBe(" hi  ");
  });
});

describe("truncate — right", () => {
  test("keeps left, marker on right", () => {
    const result = applySegmentLayout([cell("hello world")], {
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
    const result = applySegmentLayout([cell("hello world")], {
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
    const result = applySegmentLayout([cell("hello world!")], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "middle",
    });
    expect(totalWidth(result)).toBe(6);
    expect(result[0]!.plain).toBe("he…ld!");
  });
});

describe("multi-cell truncation", () => {
  test("cells are concatenated before layout; result is one cell", () => {
    const cells = [cell("hello"), cell(" world"), cell("!!")];
    const result = applySegmentLayout(cells, {
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

describe("custom truncate marker", () => {
  test("two-char marker on right", () => {
    const result = applySegmentLayout([cell("hello world")], {
      width: 7,
      justify: "left",
      padding: 0,
      truncate: "right",
      truncateMarker: ">>",
    });
    expect(result[0]!.plain).toBe("hello>>");
  });
});

describe("baseStyle on the merged cell", () => {
  test("padding inherits the cell's wrapping style (segment bg+fg continuous)", () => {
    const baseStyle = new Style({ bgcolor: "blue", color: "white" });
    const result = applySegmentLayout([cell("hi", baseStyle)], {
      width: 5,
      justify: "left",
      padding: 0,
      truncate: "right",
      baseStyle,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.plain).toBe("hi   ");
    // Padding chars carry the cell-level baseStyle, so bg+fg stay continuous.
    expect(result[0]!.style.bgcolor?.name).toBe("blue");
    expect(result[0]!.style.color?.name).toBe("white");
    expect(result[0]!.edgeStyle("left").bgcolor?.name).toBe("blue");
    expect(result[0]!.edgeStyle("right").bgcolor?.name).toBe("blue");
  });

  test("truncation marker rides on the cell's wrapping style", () => {
    const baseStyle = new Style({ bgcolor: "blue", color: "white" });
    const result = applySegmentLayout([cell("hello world", baseStyle)], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "right",
      baseStyle,
    });
    expect(result[0]!.plain).toBe("hello…");
    expect(result[0]!.style.bgcolor?.name).toBe("blue");
  });
});

// [LAW:types-are-the-program] With RichText as the cell type, truncation
// preserves spans by construction.

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
      padding: 0,
      truncate: "right",
    });
    expect(result[0]!.plain).toBe("hello…");
    // The red span is cut away entirely; assert the rendered edge colour, since
    // the collapsed cell carries the base bg as a span, not as wrapping style.
    expect(result[0]!.edgeStyle("left").bgcolor?.name).toBe("blue");
  });

  test("left truncation keeps the right side spans", () => {
    const cell = heterogeneousCell();
    const result = applySegmentLayout([cell], {
      width: 6,
      justify: "left",
      padding: 0,
      truncate: "left",
    });
    expect(result[0]!.plain).toBe("…world");
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
