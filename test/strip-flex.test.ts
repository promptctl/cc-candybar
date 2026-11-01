import { POWERLINE } from "./helpers/powerline";
import { stripCell, type PlainSegment } from "./helpers/strip-cell";
import { renderStripCells, type BuildLineOptions } from "../src/render/strip";

const seg = (text: string): PlainSegment => ({ text });

const stripOf = (
  segments: readonly PlainSegment[],
  options: BuildLineOptions,
): string =>
  renderStripCells(
    segments.map((segment) => stripCell(segment, options.padding)),
    options,
  );

describe("renderStripCells wrap behavior", () => {
  describe("plain style", () => {
    it("very wide width keeps everything on one row", () => {
      const out = stripOf([seg("alpha"), seg("beta"), seg("gamma")], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1,
        width: 200,
      });
      expect(out.split("\n")).toHaveLength(1);
      // The bundled plain joiner's separator is " | ".
      expect(out).toBe(" alpha  |  beta  |  gamma ");
    });

    it("exact-fit width keeps everything on one row", () => {
      // " alpha " (7) + " | " (3) + " beta " (6) + " | " (3) + " gamma " (7) = 26
      const oneLine = " alpha  |  beta  |  gamma ";
      expect(oneLine.length).toBe(26);
      const out = stripOf([seg("alpha"), seg("beta"), seg("gamma")], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1,
        width: oneLine.length,
      });
      expect(out.split("\n")).toHaveLength(1);
      expect(out).toBe(oneLine);
    });

    it("narrow width forces multi-row wrapping", () => {
      // 16 cells fits two segments + sep + leading/trailing pad but not all three.
      const out = stripOf([seg("alpha"), seg("beta"), seg("gamma")], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1,
        width: 16,
      });
      const rows = out.split("\n");
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        expect(row.length).toBeLessThanOrEqual(16);
      }
    });

    // brandon-display-dam.2: intra-cell padding derives from the one resolved
    // globals.padding on BuildLineOptions — 0 renders flush, N widens N per side.
    it("padding: 0 renders cells flush (no synthesized spaces)", () => {
      const out = stripOf([seg("alpha"), seg("beta")], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: true,
        padding: 0,
        width: 200,
      });
      expect(out).toBe("alpha | beta");
    });

    it("padding: 2 widens each cell by two spaces per side", () => {
      const out = stripOf([seg("alpha"), seg("beta")], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: true,
        padding: 2,
        width: 200,
      });
      expect(out).toBe("  alpha   |   beta  ");
    });

    it("wrap:false keeps a too-wide row on one unbounded line", () => {
      // Same narrow width that forces wrapping above; disabling wrap must
      // render one line with overflow allowed, NOT clip or break.
      const out = stripOf([seg("alpha"), seg("beta"), seg("gamma")], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: false, padding: 1,
        width: 16,
      });
      expect(out.split("\n")).toHaveLength(1);
      expect(out).toBe(" alpha  |  beta  |  gamma ");
    });

    it("wrap:false at a finite width is byte-equivalent to infinite width", () => {
      // The no-wrap render is the SAME unbounded line the legacy
      // width=Infinity path produced — wrap:false must not clip to width.
      const segments = [seg("alpha"), seg("beta"), seg("gamma")];
      const base = {
        endcaps: "plain" as const,
        colorCompatibility: "none" as const,
      };
      const noWrap = stripOf(segments, {
        ...base,
        wrap: false, padding: 1,
        width: 16,
      });
      const unbounded = stripOf(segments, {
        ...base,
        wrap: true, padding: 1,
        width: Number.POSITIVE_INFINITY,
      });
      expect(noWrap).toBe(unbounded);
    });

    it("infinite width is byte-equivalent to a finite width that fits", () => {
      const base = {
        endcaps: "plain" as const,
        colorCompatibility: "none" as const,
        wrap: true, padding: 1,
      };
      const segments = [seg("a"), seg("bb"), seg("ccc")];
      const unbounded = stripOf(segments, {
        ...base,
        width: Number.POSITIVE_INFINITY,
      });
      const wideFinite = stripOf(segments, { ...base, width: 200 });
      expect(wideFinite).toBe(unbounded);
    });

    it("empty segment list yields empty string", () => {
      const out = stripOf([], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1,
        width: 80,
      });
      expect(out).toBe("");
    });

    it("never emits a trailing newline", () => {
      const wide = stripOf([seg("a")], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1,
        width: 80,
      });
      const wrapped = stripOf([seg("alpha"), seg("beta")], {
        endcaps: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1,
        width: 8,
      });
      expect(wide.endsWith("\n")).toBe(false);
      expect(wrapped.endsWith("\n")).toBe(false);
    });
  });

  describe("powerline style", () => {
    it("narrow width breaks across rows with a lead and a tail cap on every row", () => {
      // The powerline cap is painted in the segment's bg (the colour bleeding
      // out), so the segments must carry a bg for a cap to exist \u2014 a fg-only
      // segment has no colour to paint and correctly gets no arrow.
      const lit = (text: string): PlainSegment => ({ text, bgHex: "#445566" });
      const out = stripOf([lit("aaa"), lit("bbb"), lit("ccc")], {
        endcaps: "powerline",
        colorCompatibility: "none",
        wrap: true, padding: 1,
        width: 8,
      });
      const rows = out.split("\n");
      expect(rows.length).toBeGreaterThan(1);
      // Every row, continuations included, is led in by the lead glyph and tailed
      // out by the tail glyph — a wrapped row has the same shape at both ends as the first.
      for (const row of rows) {
        expect(row.startsWith(POWERLINE.lead)).toBe(true);
        expect(row.endsWith(POWERLINE.tail)).toBe(true);
      }
    });
  });

  // brandon-display-dam.4: globals.colorCompatibility picks the depth rich-js
  // downsamples to. One truecolor-authored segment, four depths — the SGR
  // vocabulary in the output is the observable contract, not rich-js internals.
  describe("colorCompatibility", () => {
    const colored: PlainSegment[] = [{ text: "aaa", bgHex: "#445566" }];
    const at = (colorCompatibility: "truecolor" | "256" | "ansi" | "none") =>
      stripOf(colored, {
        endcaps: "plain",
        colorCompatibility,
        wrap: true,
        padding: 1,
        width: 200,
      });

    it("truecolor emits 24-bit SGR for a hex background", () => {
      expect(at("truecolor")).toMatch(/\x1b\[48;2;68;85;102m/);
    });

    it("256 downsamples to the 8-bit palette (no 24-bit SGR)", () => {
      const out = at("256");
      expect(out).toMatch(/\x1b\[48;5;\d+m/);
      expect(out).not.toMatch(/48;2;/);
    });

    it("ansi downsamples to the 16-color vocabulary (no 24-bit, no 8-bit)", () => {
      const out = at("ansi");
      expect(out).not.toMatch(/48;2;/);
      expect(out).not.toMatch(/48;5;/);
      expect(out).toMatch(/\x1b\[/);
    });

    it("none strips color entirely", () => {
      expect(at("none")).toBe(" aaa ");
    });
  });
});
