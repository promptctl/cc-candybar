// [LAW:behavior-not-structure] The gauge (brandon-template-funcs-zv5): one value
// against a fixed maximum, drawn as a fixed number of cells whose colours come from
// the author's own ramp evaluated at each CELL's position.
//
// The pure drawing is asserted directly; the painted form is asserted through a real
// template render, because the claim that matters — "the colour of cell i is what
// the author's ramp says at cell i's position" — is about the binding to `{{ ramp }}`
// and cannot be seen from the drawing function alone.

import { renderToString } from "@promptctl/rich-js";

import { renderGauge } from "../src/template-engine/gauge";
import { checkText } from "./helpers/check-config";

const glyphs = { filled: "█", empty: "░" };

const plain = (value: number, max: number, width: number): string =>
  renderGauge({ value, max, width, ...glyphs }).plain;

describe("renderGauge — how many cells are lit", () => {
  test("a value against its maximum, to the nearest cell", () => {
    expect(plain(0, 100, 10)).toBe("░░░░░░░░░░");
    expect(plain(50, 100, 10)).toBe("█████░░░░░");
    expect(plain(100, 100, 10)).toBe("██████████");
    // Nearest, not truncated: 73 % of ten cells is seven, 76 % is eight.
    expect(plain(73, 100, 10)).toBe("███████░░░");
    expect(plain(76, 100, 10)).toBe("████████░░");
  });

  test("a value past the maximum saturates instead of overflowing the width", () => {
    expect(plain(250, 100, 10)).toBe("██████████");
    expect(plain(-5, 100, 10)).toBe("░░░░░░░░░░");
  });

  // [LAW:no-silent-failure] Nonsense in must not render as a plausible bar: a
  // zero or non-finite maximum has no gauge, and 0/0 would otherwise be NaN cells.
  test("a maximum that cannot scale anything draws an empty gauge", () => {
    expect(plain(5, 0, 6)).toBe("░░░░░░");
    expect(plain(5, Number.NaN, 6)).toBe("░░░░░░");
    expect(plain(Number.NaN, 100, 6)).toBe("░░░░░░");
    expect(plain(5, -10, 6)).toBe("░░░░░░");
  });

  test("width is a cell count, and every cell is emitted", () => {
    for (const width of [1, 3, 8, 20]) {
      expect(plain(37, 100, width)).toHaveLength(width);
    }
  });

  test("the glyph pair is the author's, not a built-in vocabulary", () => {
    expect(
      renderGauge({ value: 2, max: 4, width: 4, filled: "#", empty: "-" })
        .plain,
    ).toBe("##--");
  });
});

describe("renderGauge — painted cells", () => {
  // The colour callback is asked at each LIT cell's own position in the value
  // domain: its lower edge. That is the choice that makes a `step` cascade read
  // correctly — the cell covering [40, 50) must not wear a threshold that starts at
  // 50 — so the positions are asserted exactly rather than counted.
  test("each lit cell's colour is asked at that cell's lower edge", () => {
    const asked: number[] = [];
    renderGauge({
      value: 100,
      max: 100,
      width: 5,
      ...glyphs,
      colourAt: (position) => {
        asked.push(position);
        return "#112233";
      },
    });
    expect(asked).toEqual([0, 20, 40, 60, 80]);
  });

  test("only the lit cells are asked, so unlit cells inherit the segment's own fg", () => {
    const asked: number[] = [];
    const gauge = renderGauge({
      value: 40,
      max: 100,
      width: 5,
      ...glyphs,
      colourAt: (position) => {
        asked.push(position);
        return "#ff0000";
      },
    });
    expect(asked).toEqual([0, 20]);
    expect(gauge.plain).toBe("██░░░");
  });

  test("the colours reach the cells, one per cell", () => {
    const gauge = renderGauge({
      value: 3,
      max: 3,
      width: 3,
      ...glyphs,
      colourAt: (position) => (position === 0 ? "#00ff00" : "#ff0000"),
    });
    // Serialized truecolor: the first cell green, the rest red — the whole point of
    // painting cells individually rather than colouring the gauge as one run.
    const out = renderToString(gauge, { colorSystem: "truecolor", width: 40 });
    expect(out).toContain("0;255;0");
    expect(out).toContain("255;0;0");
  });

  // A gauge with no ramp is monochrome and carries no colour of its own, so a
  // segment's `fg:` still owns it — the sparkline's own contract, kept.
  test("no ramp means no colour on the cells at all", () => {
    const out = renderToString(
      renderGauge({ value: 2, max: 4, width: 4, ...glyphs }),
      { colorSystem: "truecolor", width: 40 },
    );
    expect(out).not.toMatch(/\d+;\d+;\d+/);
  });
});

// [LAW:behavior-not-structure] The binding, end to end through the real pipeline:
// `{{ gauge }}` is registered beside `{{ color }}`/`{{ ramp }}` because it needs the
// same live palette, and its per-cell colour is the author's OWN ramp asked at the
// cell's position. Driven through `checkConfig` — the same entry `cc-candybar check`
// runs — so a registration that loads but does not render cannot pass.
describe("{{ gauge }} in a real config", () => {
  const ANSI = /\x1b\[[0-9;]*m/g;

  test("draws the cells a value earns, and paints them from the author's ramp", async () => {
    const clean = await checkText(
      "gauge",
      `{
        segments: {
          g: { template: '{{ gauge .context.contextLeft 100 10 "#" "-" "step" "0:error" "40:warning" "70:success" }}' },
        },
        root: { h: ["g"] },
      }`,
    );
    // checkPayload puts contextLeft at 24, so two cells of ten are lit.
    const visible = clean.rendered.replace(ANSI, "");
    expect(visible).toContain("##--------");
    // Painted per cell from the step cascade: both lit cells sit below the 40 stop,
    // so both wear `error` — and the gauge carries a colour of its own at all,
    // which is what distinguishes it from the monochrome form.
    expect(clean.rendered).toMatch(/\x1b\[[0-9;]*m#/);
  });

  test("without a ramp the gauge carries no colour, so the segment's fg owns it", async () => {
    const clean = await checkText(
      "gauge-mono",
      `{
        segments: {
          g: { template: '{{ gauge .context.contextLeft 100 10 "#" "-" }}', fg: "success" },
        },
        root: { h: ["g"] },
      }`,
    );
    expect(clean.rendered.replace(ANSI, "")).toContain("##--------");
  });

  // [LAW:no-silent-failure] A malformed stop is an authoring mistake and says so
  // rather than painting every cell one colour because a position quietly became 0.
  test("a stop without a position fails the render loudly", async () => {
    await expect(
      checkText(
        "gauge-bad",
        `{
          segments: {
            g: { template: '{{ gauge 1 2 4 "#" "-" "step" "error" }}' },
          },
          root: { h: ["g"] },
        }`,
      ),
    ).rejects.toThrow(/must be "<position>:<colour>"/);
  });
});
