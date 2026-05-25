// [LAW:behavior-not-structure] Tests assert observable output (cell count,
// text content, total width, style fields) — never internal state.

import { StripCell, cellLen } from "@promptctl/rich-js";
import { createCcCandybarEngine } from "../src/template-engine/engine";
import { applySegmentLayout, evaluateWhen } from "../src/template-engine/layout";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cell(text: string): StripCell {
  return new StripCell(text);
}

function totalWidth(cells: StripCell[]): number {
  return cells.reduce((sum, c) => sum + cellLen(c.text), 0);
}

function text(cells: StripCell[]): string[] {
  return cells.map((c) => c.text);
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
// 2. applySegmentLayout — auto width (no constraint)
// ────────────────────────────────────────────────────────────────────────────

describe("auto width — no layout constraint applied", () => {
  test("returns cells unchanged", () => {
    const cells = [cell("hello"), cell(" world")];
    const result = applySegmentLayout(cells, autoOptions);
    expect(text(result)).toEqual(["hello", " world"]);
  });

  test("empty input returns empty", () => {
    expect(applySegmentLayout([], autoOptions)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Fixed width — exact fit (no truncation or padding needed)
// ────────────────────────────────────────────────────────────────────────────

describe("fixed width — exact fit", () => {
  test("cells that already fill the width are returned as-is", () => {
    const cells = [cell("hello")]; // 5 chars
    const result = applySegmentLayout(cells, {
      width: 5,
      justify: "left",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(text(result)).toEqual(["hello"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Fixed width — padding / justification
// ────────────────────────────────────────────────────────────────────────────

describe("justify — left", () => {
  test("adds trailing space to reach target width", () => {
    const cells = [cell("hi")]; // 2 chars, target 5
    const result = applySegmentLayout(cells, {
      width: 5,
      justify: "left",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(text(result)[0]).toBe("hi");
    expect(text(result)[text(result).length - 1]).toBe("   ");
  });
});

describe("justify — right", () => {
  test("adds leading space to reach target width", () => {
    const cells = [cell("hi")]; // 2 chars, target 5
    const result = applySegmentLayout(cells, {
      width: 5,
      justify: "right",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(text(result)[0]).toBe("   ");
    expect(text(result)[1]).toBe("hi");
  });
});

describe("justify — center", () => {
  test("even padding: splits evenly", () => {
    const cells = [cell("hi")]; // 2 chars, target 6, pad = 4
    const result = applySegmentLayout(cells, {
      width: 6,
      justify: "center",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(6);
    expect(text(result)[0]).toBe("  "); // left pad = floor(4/2) = 2
    expect(text(result)[1]).toBe("hi");
    expect(text(result)[2]).toBe("  "); // right pad = 2
  });

  test("odd padding: right side gets one extra space", () => {
    const cells = [cell("hi")]; // 2 chars, target 5, pad = 3
    const result = applySegmentLayout(cells, {
      width: 5,
      justify: "center",
      truncate: "right",
    });
    expect(totalWidth(result)).toBe(5);
    expect(text(result)[0]).toBe(" "); // left = floor(3/2) = 1
    expect(text(result)[1]).toBe("hi");
    expect(text(result)[2]).toBe("  "); // right = 2
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Fixed width — truncation
// ────────────────────────────────────────────────────────────────────────────

describe("truncate — right", () => {
  test("keeps left portion, appends marker", () => {
    const cells = [cell("hello world")]; // 11 chars, target 8 → budget 7
    const result = applySegmentLayout(cells, {
      width: 8,
      justify: "left",
      truncate: "right",
      truncateMarker: "…",
    });
    expect(totalWidth(result)).toBe(8);
    const flat = text(result).join("");
    expect(flat.endsWith("…")).toBe(true);
    expect(flat.startsWith("hello w")).toBe(true);
  });

  test("marker is the last cell", () => {
    const result = applySegmentLayout([cell("abcdef")], {
      width: 4,
      justify: "left",
      truncate: "right",
      truncateMarker: "…",
    });
    expect(text(result).at(-1)).toBe("…");
  });
});

describe("truncate — left", () => {
  test("keeps right portion, prepends marker", () => {
    const cells = [cell("hello world")]; // 11 chars, target 8 → budget 7
    const result = applySegmentLayout(cells, {
      width: 8,
      justify: "left",
      truncate: "left",
      truncateMarker: "…",
    });
    expect(totalWidth(result)).toBe(8);
    const flat = text(result).join("");
    expect(flat.startsWith("…")).toBe(true);
    expect(flat.endsWith("o world")).toBe(true);
  });

  test("marker is the first cell", () => {
    const result = applySegmentLayout([cell("abcdef")], {
      width: 4,
      justify: "left",
      truncate: "left",
      truncateMarker: "…",
    });
    expect(text(result)[0]).toBe("…");
  });
});

describe("truncate — middle", () => {
  test("keeps outer portions, inserts marker in the middle", () => {
    const cells = [cell("hello world!")]; // 12 chars, target 7 → budget 6
    const result = applySegmentLayout(cells, {
      width: 7,
      justify: "left",
      truncate: "middle",
      truncateMarker: "…",
    });
    expect(totalWidth(result)).toBe(7);
    const parts = text(result);
    // marker must be in the middle, not first or last
    const markerIdx = parts.indexOf("…");
    expect(markerIdx).toBeGreaterThan(0);
    expect(markerIdx).toBeLessThan(parts.length - 1);
  });

  test("total width matches target", () => {
    const result = applySegmentLayout([cell("abcdefghijkl")], {
      width: 9,
      justify: "left",
      truncate: "middle",
      truncateMarker: "…",
    });
    expect(totalWidth(result)).toBe(9);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Multi-cell truncation
// ────────────────────────────────────────────────────────────────────────────

describe("multi-cell truncation", () => {
  test("right truncation spans multiple cells", () => {
    const cells = [cell("abc"), cell("def"), cell("ghi")]; // 9 chars total
    const result = applySegmentLayout(cells, {
      width: 5,
      justify: "left",
      truncate: "right",
      truncateMarker: "…",
    });
    expect(totalWidth(result)).toBe(5);
    expect(text(result).at(-1)).toBe("…");
    // content before marker: "abcd" (4 chars)
    const contentText = text(result).slice(0, -1).join("");
    expect(contentText).toBe("abcd");
  });

  test("left truncation spans multiple cells", () => {
    const cells = [cell("abc"), cell("def"), cell("ghi")]; // 9 chars total
    const result = applySegmentLayout(cells, {
      width: 5,
      justify: "left",
      truncate: "left",
      truncateMarker: "…",
    });
    expect(totalWidth(result)).toBe(5);
    expect(text(result)[0]).toBe("…");
    const contentText = text(result).slice(1).join("");
    expect(contentText).toBe("fghi");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Custom truncate marker
// ────────────────────────────────────────────────────────────────────────────

describe("custom truncate marker", () => {
  test("multi-char marker is accounted for in width budget", () => {
    const result = applySegmentLayout([cell("hello world")], {
      width: 8,
      justify: "left",
      truncate: "right",
      truncateMarker: ">>",
    });
    expect(totalWidth(result)).toBe(8);
    expect(text(result).at(-1)).toBe(">>");
  });

  test("default marker is '…' (1 column)", () => {
    const result = applySegmentLayout([cell("hello world")], {
      width: 5,
      justify: "left",
      truncate: "right",
    });
    expect(text(result).at(-1)).toBe("…");
  });
});
