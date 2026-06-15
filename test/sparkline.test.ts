// [LAW:behavior-not-structure] These assert the sparkline CONTRACT — a numeric
// series maps to a deterministic glyph string, relative to the window's own
// min/max — never the internals of how the index is computed.

import {
  renderSparkline,
  parseSeries,
  SPARK_LEVELS,
} from "../src/template-engine/sparkline";
import { createCcCandybarEngine } from "../src/template-engine/engine";

// Evaluate the registered `sparkline` template func against a plain scope.
function evalText(source: string, scope: object): string {
  const engine = createCcCandybarEngine();
  return engine
    .parse(source)
    .evaluate(scope)
    .map((rt) => rt.plain)
    .join("");
}

const [LOW, , , , MID, , , HIGH] = SPARK_LEVELS;

// ─── renderSparkline: the pure core on fixed input series ─────────────────────

describe("renderSparkline — pure rendering of a fixed series", () => {
  test("empty series renders nothing", () => {
    expect(renderSparkline([])).toBe("");
  });

  test("a perfectly increasing 8-step series fills the whole ramp", () => {
    // min=1, max=8, range=7 ⇒ idx = round((v-1)/7 * 7) = v-1 ⇒ 0..7.
    expect(renderSparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe(SPARK_LEVELS.join(""));
  });

  test("endpoints always hit the lowest and highest glyph (relative scale)", () => {
    const out = renderSparkline([3, 50, 17, 99, 4]);
    expect(out[0]).toBe(LOW); // the min (3) → lowest tier
    expect(out).toContain(HIGH); // the max (99) → highest tier
    expect(out.length).toBe(5);
  });

  test("a flat series falls to the lowest tier (no variation to show)", () => {
    expect(renderSparkline([42, 42, 42])).toBe(LOW + LOW + LOW);
  });

  test("a single sample is the lowest tier", () => {
    expect(renderSparkline([7])).toBe(LOW);
  });

  test("negative values normalize against the window min", () => {
    // min=-5, max=5, range=10 ⇒ -5→0, 0→round(3.5)=4 (MID), 5→7 (HIGH).
    expect(renderSparkline([-5, 0, 5])).toBe(LOW + MID + HIGH);
  });

  test("constant magnitude does not affect shape — only relative variation does", () => {
    // Same shape at two magnitudes renders identically (relative, not absolute).
    expect(renderSparkline([10, 20, 30])).toBe(
      renderSparkline([1000, 2000, 3000]),
    );
  });
});

describe("renderSparkline — width caps the window to the recent tail", () => {
  test("width shows the LAST `width` samples", () => {
    // Last 3 of [1..5] = [3,4,5]; min=3,max=5,range=2 ⇒ 3→0, 4→round(3.5)=4, 5→7.
    expect(renderSparkline([1, 2, 3, 4, 5], 3)).toBe(LOW + MID + HIGH);
  });

  test("width larger than the series renders every sample", () => {
    expect(renderSparkline([1, 8], 100)).toBe(LOW + HIGH);
  });

  test("width of zero renders nothing", () => {
    expect(renderSparkline([1, 2, 3], 0)).toBe("");
  });

  test("the rendered width never exceeds the cap", () => {
    expect([...renderSparkline([1, 2, 3, 4, 5, 6, 7, 8], 4)].length).toBe(4);
  });
});

// ─── parseSeries: the scalar-seam decoder ─────────────────────────────────────

describe("parseSeries — decode the delimited series string", () => {
  test("empty string is the genuine empty series", () => {
    expect(parseSeries("")).toEqual([]);
  });

  test("comma-delimited numbers decode in order", () => {
    expect(parseSeries("1,2,3")).toEqual([1, 2, 3]);
  });

  test("decimals and surrounding whitespace are tolerated", () => {
    expect(parseSeries(" 1.5 , 2 , 3.25 ")).toEqual([1.5, 2, 3.25]);
  });

  test("blank tokens (absence) drop; numeric tokens are kept", () => {
    expect(parseSeries("1,,2,")).toEqual([1, 2]);
  });

  test("a non-numeric token fails loudly rather than being skipped", () => {
    expect(() => parseSeries("1,oops,3")).toThrow(/non-numeric series element/);
  });
});

// ─── The registered template helper end to end ────────────────────────────────

describe("sparkline template func", () => {
  test("renders a graph from a series-string scope field", () => {
    expect(evalText("{{ sparkline .s }}", { s: "1,2,3,4,5,6,7,8" })).toBe(
      SPARK_LEVELS.join(""),
    );
  });

  test("the optional width arg caps the cell", () => {
    expect(evalText("{{ sparkline .s 3 }}", { s: "1,2,3,4,5" })).toBe(
      LOW + MID + HIGH,
    );
  });

  test("an empty series field renders nothing", () => {
    expect(evalText("{{ sparkline .s }}", { s: "" })).toBe("");
  });
});
