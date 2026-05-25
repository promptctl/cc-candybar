// [LAW:behavior-not-structure] Tests assert cell structure (count, text,
// style.link presence) and style outcomes, never AST shapes or internal
// state of the conversion walk.

import { createCcCandybarEngine } from "../src/template-engine/engine";
import { fragmentsToStripCells } from "../src/template-engine/cells";
import { renderStripCells } from "../src/render/strip";
import { RichText, StripCell, Style } from "@promptctl/rich-js";

// Render cells to a truecolor ANSI string so tests assert observable output
// (SGR escapes), not internal style placement. [LAW:behavior-not-structure]
function renderCells(cells: readonly StripCell[]): string {
  return renderStripCells(cells, { style: "plain", colorCompatibility: "truecolor" });
}

// CSI prefix of an ANSI SGR sequence (ESC + "[").
const SGR = "\x1b[";

// Strip ANSI SGR escapes so a test can assert the visible text independently of
// where styling is applied.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

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
  test("two top-level link calls with a joiner between produce link + plain + link", () => {
    // The inter-link space is unlinked plain text; it becomes its own cell rather
    // than being absorbed into either neighbour. Same reasoning as the
    // "leading joiner" test below.
    const cells = evalCells('{{ link "http://a" "A" }} {{ link "http://b" "B" }}');
    expect(cells).toHaveLength(3);
    expect(cells[0]!.style.link).toBe("http://a");
    expect(cells[0]!.text).toBe("A");
    expect(cells[1]!.style.link).toBeUndefined();
    expect(cells[1]!.text).toBe(" ");
    expect(cells[2]!.style.link).toBe("http://b");
    expect(cells[2]!.text).toBe("B");
  });

  test("link cell text is correct", () => {
    const cells = evalCells('{{ link "http://x" "click me" }}');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("click me");
    expect(cells[0]!.style.link).toBe("http://x");
  });

  test("three link calls separated by joiners produce link/plain/link/plain/link", () => {
    // Five cells, not three: the inter-link spaces are plain cells. The link
    // boundary is determined by the fragment's style.link, not by what's
    // adjacent to it.
    const cells = evalCells(
      '{{ link "u1" "A" }} {{ link "u2" "B" }} {{ link "u3" "C" }}'
    );
    expect(cells).toHaveLength(5);
    expect(cells[0]!.style.link).toBe("u1");
    expect(cells[1]!.style.link).toBeUndefined();
    expect(cells[2]!.style.link).toBe("u2");
    expect(cells[3]!.style.link).toBeUndefined();
    expect(cells[4]!.style.link).toBe("u3");
  });

  test("leading joiner becomes its own plain cell, separate from the link", () => {
    // [LAW:types-are-the-program] A StripCell with style.link asserts "my whole
    // content is clickable". Unlinked prefix text must NOT be absorbed into the
    // link cell — that would make the type's claim false (and would render the
    // prefix clickable when the template never said so). The joiner becomes its
    // own plain cell, the link is its own cell.
    const cells = evalCells('prefix {{ link "u" "item" }}');
    expect(cells).toHaveLength(2);
    expect(cells[0]!.text).toBe("prefix ");
    expect(cells[0]!.style.link).toBeUndefined();
    expect(cells[1]!.text).toBe("item");
    expect(cells[1]!.style.link).toBe("u");
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

  test("plain run preserves a styled fragment's fg in rendered output", () => {
    const cells = fragmentsToStripCells([
      new RichText("status: "),
      new RichText("err", { style: "red" }),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("status: err");

    // Behavioral proof: the red fg actually survives to ANSI output. A flatten
    // to an unstyled plain cell would emit no SGR escape and fail this.
    const rendered = renderCells(cells);
    expect(rendered).toContain(SGR);
    // Visible text (escapes removed) is intact and unduplicated.
    expect(stripAnsi(rendered)).toBe("status: err");
  });

  test("adjacent fragments sharing a background coalesce, keeping the bg", () => {
    // Same bg on both → one cell. The background is joiner-visible, so it must
    // survive at cell level rather than being stripped to nothing.
    const cells = fragmentsToStripCells([
      new RichText("a", { style: "on blue" }),
      new RichText("b", { style: "on blue" }),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.text).toBe("ab");
    expect(cells[0]!.style.bgcolor).toBeDefined();
  });

  test("a background change is a cell boundary", () => {
    // Divergent backgrounds cannot share one cell (single-style invariant), so
    // the run splits — each background becomes its own powerline cell.
    const cells = fragmentsToStripCells([
      new RichText("a", { style: "on red" }),
      new RichText("b", { style: "on blue" }),
    ]);
    expect(cells).toHaveLength(2);
    expect(cells[0]!.text).toBe("a");
    expect(cells[1]!.text).toBe("b");
    expect(cells[0]!.style.bgcolor).not.toBe(cells[1]!.style.bgcolor);
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

// ────────────────────────────────────────────────────────────────
// 5. baseStyle merge — segment bg/fg layered under fragments
//
// Replaces the former "default-style cascade" tests that lived under
// applySegmentLayout: the merge now happens at cell construction time
// (so per-fragment fg becomes a part rather than being lost to a
// later cell-level rebuild). The assertions here mirror those guarantees.
// ────────────────────────────────────────────────────────────────

describe("baseStyle merge — fragment style wins on overlap", () => {
  test("unstyled fragment inherits baseStyle bg", () => {
    const baseStyle = new Style({ bgcolor: "blue" });
    const cells = fragmentsToStripCells([new RichText("text")], baseStyle);
    expect(cells[0]!.style.bgcolor?.name).toBe("blue");
  });

  test("fragment's own bg wins over baseStyle bg", () => {
    const baseStyle = new Style({ bgcolor: "blue" });
    const cells = fragmentsToStripCells(
      [new RichText("text", { style: "on red" })],
      baseStyle,
    );
    // A divergent bg must NOT be overridden by the segment default.
    expect(cells[0]!.style.bgcolor?.name).toBe("red");
  });

  test("null baseStyle → fragments flow through unchanged", () => {
    const cells = fragmentsToStripCells([new RichText("text")], new Style());
    expect(cells[0]!.style.isNull).toBe(true);
  });

  test("no baseStyle → fragments flow through unchanged", () => {
    const cells = fragmentsToStripCells([new RichText("text")]);
    expect(cells[0]!.style.isNull).toBe(true);
  });

  test("baseStyle fg applied to fragment without fg", () => {
    const baseStyle = new Style({ color: "white" });
    const cells = fragmentsToStripCells([new RichText("text")], baseStyle);
    expect(cells[0]!.style.color?.name).toBe("white");
  });

  test("fragment's own fg wins over baseStyle fg", () => {
    const baseStyle = new Style({ color: "white" });
    const cells = fragmentsToStripCells(
      [new RichText("text", { style: "red" })],
      baseStyle,
    );
    expect(cells[0]!.style.color?.name).toBe("red");
  });
});

describe("baseStyle merge preserves per-fragment fg as cell parts", () => {
  // This is the gitTaculous-shaped case the structural fix targets: multiple
  // fragments with their own fg, under a shared segment bg, must coalesce into
  // ONE cell (single bg) while each fragment's fg survives as a part. The OLD
  // layout-time merge would rebuild as `new StripCell(text, mergedStyle)` and
  // drop parts; the new cell-time merge keeps them.
  test("fragments with per-fragment fg under a shared bg form one cell with N parts", () => {
    const baseStyle = new Style({ bgcolor: "blue" });
    const cells = fragmentsToStripCells(
      [
        new RichText(" prefix "),
        new RichText("S", { style: "green" }),
        new RichText("U", { style: "red" }),
        new RichText(" suffix "),
      ],
      baseStyle,
    );
    // All fragments share the same bg (from baseStyle) → one cell.
    expect(cells).toHaveLength(1);
    // Cell-level bg survived.
    expect(cells[0]!.style.bgcolor?.name).toBe("blue");

    // The per-fragment fg must reach the ANSI output as distinct SGR groups —
    // not collapsed into one fg. The serializer wraps each SGR-codes group
    // separately, so the rendered string must contain at least 3 distinct
    // SGR open sequences (one for the baseline-fg run, one for green, one for
    // red — plus possibly more for transitions back to baseline).
    const rendered = renderStripCells(cells, {
      style: "plain",
      colorCompatibility: "truecolor",
    });
    expect(stripAnsi(rendered)).toBe(" prefix SU suffix ");
    // At least three SGR opens (green segment + red segment + a baseline) means
    // the parts survived as distinct foregrounds.
    const sgrOpens = rendered.match(/\x1b\[[0-9;]+m/g) ?? [];
    expect(sgrOpens.length).toBeGreaterThanOrEqual(3);
  });
});
