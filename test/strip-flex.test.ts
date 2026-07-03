import { buildLineStrip } from "../src/render/strip";

const seg = (text: string) => ({ type: "x", text });

describe("renderStripCells wrap behavior (via buildLineStrip adapter)", () => {
  describe("plain style", () => {
    it("very wide width keeps everything on one row", () => {
      const out = buildLineStrip([seg("alpha"), seg("beta"), seg("gamma")], {
        style: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1, charset: "unicode" as const,
        width: 200,
      });
      expect(out.split("\n")).toHaveLength(1);
      // PlainJoiner default separator is " | ".
      expect(out).toBe(" alpha  |  beta  |  gamma ");
    });

    it("exact-fit width keeps everything on one row", () => {
      // " alpha " (7) + " | " (3) + " beta " (6) + " | " (3) + " gamma " (7) = 26
      const oneLine = " alpha  |  beta  |  gamma ";
      expect(oneLine.length).toBe(26);
      const out = buildLineStrip([seg("alpha"), seg("beta"), seg("gamma")], {
        style: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1, charset: "unicode" as const,
        width: oneLine.length,
      });
      expect(out.split("\n")).toHaveLength(1);
      expect(out).toBe(oneLine);
    });

    it("narrow width forces multi-row wrapping", () => {
      // 16 cells fits two segments + sep + leading/trailing pad but not all three.
      const out = buildLineStrip([seg("alpha"), seg("beta"), seg("gamma")], {
        style: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1, charset: "unicode" as const,
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
      const out = buildLineStrip([seg("alpha"), seg("beta")], {
        style: "plain",
        colorCompatibility: "none",
        wrap: true,
        padding: 0,
        charset: "unicode",
        width: 200,
      });
      expect(out).toBe("alpha | beta");
    });

    it("padding: 2 widens each cell by two spaces per side", () => {
      const out = buildLineStrip([seg("alpha"), seg("beta")], {
        style: "plain",
        colorCompatibility: "none",
        wrap: true,
        padding: 2,
        charset: "unicode",
        width: 200,
      });
      expect(out).toBe("  alpha   |   beta  ");
    });

    it("wrap:false keeps a too-wide row on one unbounded line", () => {
      // Same narrow width that forces wrapping above; disabling wrap must
      // render one line with overflow allowed, NOT clip or break.
      const out = buildLineStrip([seg("alpha"), seg("beta"), seg("gamma")], {
        style: "plain",
        colorCompatibility: "none",
        wrap: false, padding: 1, charset: "unicode" as const,
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
        style: "plain" as const,
        colorCompatibility: "none" as const,
      };
      const noWrap = buildLineStrip(segments, {
        ...base,
        wrap: false, padding: 1, charset: "unicode" as const,
        width: 16,
      });
      const unbounded = buildLineStrip(segments, {
        ...base,
        wrap: true, padding: 1, charset: "unicode" as const,
        width: Number.POSITIVE_INFINITY,
      });
      expect(noWrap).toBe(unbounded);
    });

    it("infinite width is byte-equivalent to a finite width that fits", () => {
      const base = {
        style: "plain" as const,
        colorCompatibility: "none" as const,
        wrap: true, padding: 1, charset: "unicode" as const,
      };
      const segments = [seg("a"), seg("bb"), seg("ccc")];
      const unbounded = buildLineStrip(segments, {
        ...base,
        width: Number.POSITIVE_INFINITY,
      });
      const wideFinite = buildLineStrip(segments, { ...base, width: 200 });
      expect(wideFinite).toBe(unbounded);
    });

    it("empty segment list yields empty string", () => {
      const out = buildLineStrip([], {
        style: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1, charset: "unicode" as const,
        width: 80,
      });
      expect(out).toBe("");
    });

    it("never emits a trailing newline", () => {
      const wide = buildLineStrip([seg("a")], {
        style: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1, charset: "unicode" as const,
        width: 80,
      });
      const wrapped = buildLineStrip([seg("alpha"), seg("beta")], {
        style: "plain",
        colorCompatibility: "none",
        wrap: true, padding: 1, charset: "unicode" as const,
        width: 8,
      });
      expect(wide.endsWith("\n")).toBe(false);
      expect(wrapped.endsWith("\n")).toBe(false);
    });
  });

  describe("powerline style", () => {
    it("narrow width breaks across rows with arrow caps on every row", () => {
      // The powerline cap is painted in the segment's bg (the colour bleeding
      // out), so the segments must carry a bg for a cap to exist \u2014 a fg-only
      // segment has no colour to paint and correctly gets no arrow.
      const lit = (text: string) => ({ type: "x", text, bgHex: "#445566" });
      const out = buildLineStrip([lit("aaa"), lit("bbb"), lit("ccc")], {
        style: "powerline",
        colorCompatibility: "none",
        wrap: true, padding: 1, charset: "unicode" as const,
        width: 8,
      });
      const rows = out.split("\n");
      expect(rows.length).toBeGreaterThan(1);
      // PowerlineJoiner end-cap: every row ends with the arrow glyph U+E0B0.
      for (const row of rows) {
        expect(row.endsWith("\uE0B0")).toBe(true);
      }
    });
  });

  // brandon-display-dam.3: globals.charset swaps the joiner glyph vocabulary.
  // Style picks the joiner SHAPE, charset the glyph VALUES \u2014 orthogonal axes.
  describe("charset", () => {
    const lit = (text: string) => ({ type: "x", text, bgHex: "#445566" });
    // Any powerline private-use glyph is mojibake on a non-Nerd-Font terminal;
    // the ascii renders must contain NONE, not merely different caps.
    const PUA = /[\u{E000}-\u{F8FF}]/u;

    it("powerline + ascii joins and caps with '>' and emits no private-use glyphs", () => {
      const out = buildLineStrip([lit("aaa"), lit("bbb")], {
        style: "powerline",
        colorCompatibility: "none",
        wrap: true,
        padding: 1,
        charset: "ascii",
        width: 200,
      });
      expect(out).toBe(" aaa > bbb >");
      expect(PUA.test(out)).toBe(false);
    });

    it("capsule + ascii brackets each row with '(' and ')' and emits no private-use glyphs", () => {
      const out = buildLineStrip([lit("aaa"), lit("bbb")], {
        style: "capsule",
        colorCompatibility: "none",
        wrap: true,
        padding: 1,
        charset: "ascii",
        width: 200,
      });
      expect(out.startsWith("(")).toBe(true);
      expect(out.endsWith(")")).toBe(true);
      expect(PUA.test(out)).toBe(false);
    });

    it("plain is charset-invariant (its separator is already user data)", () => {
      const base = {
        style: "plain" as const,
        colorCompatibility: "none" as const,
        wrap: true,
        padding: 1,
        width: 200,
      };
      const ascii = buildLineStrip([seg("aaa"), seg("bbb")], {
        ...base,
        charset: "ascii",
      });
      const unicode = buildLineStrip([seg("aaa"), seg("bbb")], {
        ...base,
        charset: "unicode",
      });
      expect(ascii).toBe(unicode);
    });

    it("charset composes with the configured plain separator", () => {
      const out = buildLineStrip([seg("aaa"), seg("bbb")], {
        style: "plain",
        colorCompatibility: "none",
        separator: " :: ",
        wrap: true,
        padding: 1,
        charset: "ascii",
        width: 200,
      });
      expect(out).toBe(" aaa  ::  bbb ");
    });
  });

  // brandon-display-dam.4: globals.colorCompatibility picks the depth rich-js
  // downsamples to. One truecolor-authored segment, four depths — the SGR
  // vocabulary in the output is the observable contract, not rich-js internals.
  describe("colorCompatibility", () => {
    const colored = [{ type: "x", text: "aaa", bgHex: "#445566" }];
    const at = (colorCompatibility: "truecolor" | "256" | "ansi" | "none") =>
      buildLineStrip(colored, {
        style: "plain",
        colorCompatibility,
        wrap: true,
        padding: 1,
        charset: "unicode",
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
