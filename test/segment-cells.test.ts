// [LAW:behavior-not-structure] Tests assert cell structure (count, text,
// style.link presence) and style outcomes, never AST shapes or internal
// state of the conversion walk.

import { createCcCandybarEngine } from "../src/template-engine/engine";
import { fragmentsToStripCells } from "../src/template-engine/cells";
import { RichText } from "@promptctl/rich-js";

// Helper: evaluate a template and convert to StripCells.
function evalCells(source: string, scope: object = {}) {
  const engine = createCcCandybarEngine();
  const fragments = engine.parse(source).evaluate(scope);
  return fragmentsToStripCells(fragments);
}

// ────────────────────────────────────────────────────────────────
// 1. Single-cell segments
// ────────────────────────────────────────────────────────────────

describe("single-cell segments", () => {
  test("plain text produces one cell with that text", () => {
    const cells = evalCells("hello world");
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("hello world");
    expect(cells[0]!.style.link).toBeUndefined();
  });

  test("interpolated field produces one cell", () => {
    const cells = evalCells("{{ .branch }}", { branch: "main" });
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("main");
  });

  test("empty template produces no cells", () => {
    const cells = evalCells("");
    expect(cells).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Multi-cell (toolbar shape) — top-level link calls split cells
// ────────────────────────────────────────────────────────────────

describe("multi-cell toolbar shape", () => {
  test("two top-level link calls produce two cells", () => {
    const cells = evalCells('{{ link "http://a" "A" }} {{ link "http://b" "B" }}');
    expect(cells).toHaveLength(2);
    expect(cells[0]!.style.link).toBe("http://a");
    expect(cells[1]!.style.link).toBe("http://b");
  });

  test("link cell text is correct", () => {
    const cells = evalCells('{{ link "http://x" "click me" }}');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("click me");
    expect(cells[0]!.style.link).toBe("http://x");
  });

  test("three link calls produce three cells", () => {
    const cells = evalCells(
      '{{ link "u1" "A" }} {{ link "u2" "B" }} {{ link "u3" "C" }}'
    );
    expect(cells).toHaveLength(3);
    expect(cells[0]!.style.link).toBe("u1");
    expect(cells[1]!.style.link).toBe("u2");
    expect(cells[2]!.style.link).toBe("u3");
  });

  test("leading joiner text prepends to first link cell", () => {
    // Joiner text before the first link is prepended to the link cell text.
    const cells = evalCells('prefix {{ link "u" "item" }}');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("prefix item");
    expect(cells[0]!.style.link).toBe("u");
  });

  test("trailing plain text after last link becomes its own plain cell", () => {
    const cells = evalCells('{{ link "u" "item" }} suffix');
    expect(cells).toHaveLength(2);
    expect(cells[0]!.style.link).toBe("u");
    expect(cells[1]!.text).toBe(" suffix");
    expect(cells[1]!.style.link).toBeUndefined();
  });

  test("link with field interpolation in label", () => {
    const cells = evalCells('{{ link "http://go" .label }}', { label: "Go" });
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("Go");
    expect(cells[0]!.style.link).toBe("http://go");
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Nested style functions — inline color inside a cell
// ────────────────────────────────────────────────────────────────

describe("nested style functions inside one cell", () => {
  test("bold wrapping text produces cell with bold style", () => {
    const cells = evalCells('{{ bold "hello" }}');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.style.bold).toBe(true);
    expect(cells[0]!.text).toBe("hello");
  });

  test("red text produces cell with color set", () => {
    const cells = evalCells('{{ red "error" }}');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.style.color).toBeDefined();
    expect(cells[0]!.text).toBe("error");
  });

  test("nested: bold inside red — outer wins on color, bold carried", () => {
    const cells = evalCells('{{ red (bold "x") }}');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.style.color).toBeDefined(); // red
    expect(cells[0]!.style.bold).toBe(true);
    expect(cells[0]!.text).toBe("x");
  });

  test("styled fragment inside link call preserves styling", () => {
    const cells = evalCells('{{ link "http://go" (bold "go!") }}');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.style.link).toBe("http://go");
    expect(cells[0]!.style.bold).toBe(true);
    expect(cells[0]!.text).toBe("go!");
  });
});

// ────────────────────────────────────────────────────────────────
// 4. fragmentsToStripCells called directly with pre-built fragments
// ────────────────────────────────────────────────────────────────

describe("fragmentsToStripCells — direct fragment input", () => {
  test("empty array produces empty cells", () => {
    expect(fragmentsToStripCells([])).toHaveLength(0);
  });

  test("single unstyled RichText → single plain cell", () => {
    const cells = fragmentsToStripCells([new RichText("hello")]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("hello");
  });

  test("a run of adjacent plain fragments coalesces into one cell", () => {
    // The natural symbol+value+padding shape — " {{ .sym }} {{ .v }} " —
    // evaluates to several plain fragments. They must form ONE powerline cell,
    // not one cell per fragment (which would cap-separate a single segment).
    const cells = fragmentsToStripCells([
      new RichText(" "),
      new RichText("hello"),
      new RichText(" "),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe(" hello ");
    expect(cells[0]!.style.link).toBeUndefined();
  });

  test("plain run preserves a styled fragment's fg as a part overlay", () => {
    const styled = new RichText("err", { style: "red" });
    const cells = fragmentsToStripCells([
      new RichText("status: "),
      styled,
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("status: err");
    // No single dominant style across the run → cell-level style stays null.
    expect(cells[0]!.style.isNull).toBe(true);
  });

  test("span with bgcolor does not propagate bgcolor to cell part", () => {
    // Build a RichText carrying a link (so it becomes a cell) with a span
    // that has both fg (red) and bgcolor (blue). The StripCell must be
    // constructed without throwing — i.e., we strip bgcolor from part styles.
    const rt = new RichText("hello", { style: "link http://x" });
    rt.stylize("red on blue"); // stylize(style, start?, end?)
    const cells = fragmentsToStripCells([rt]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.style.link).toBe("http://x");
  });
});
