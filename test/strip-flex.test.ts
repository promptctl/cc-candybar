import { buildFlexStripLines, buildLineStrip } from "../src/render/strip";

const seg = (text: string) => ({ type: "x", text });

describe("buildFlexStripLines wrap behavior", () => {
  describe("plain style", () => {
    it("very wide width keeps everything on one row", () => {
      const out = buildFlexStripLines(
        [seg("alpha"), seg("beta"), seg("gamma")],
        { style: "plain", colorCompatibility: "none", width: 200 },
      );
      expect(out.split("\n")).toHaveLength(1);
      // PlainJoiner default separator is " | ".
      expect(out).toBe(" alpha  |  beta  |  gamma ");
    });

    it("exact-fit width keeps everything on one row", () => {
      // " alpha " (7) + " | " (3) + " beta " (6) + " | " (3) + " gamma " (7) = 26
      const oneLine = " alpha  |  beta  |  gamma ";
      expect(oneLine.length).toBe(26);
      const out = buildFlexStripLines(
        [seg("alpha"), seg("beta"), seg("gamma")],
        { style: "plain", colorCompatibility: "none", width: oneLine.length },
      );
      expect(out.split("\n")).toHaveLength(1);
      expect(out).toBe(oneLine);
    });

    it("narrow width forces multi-row wrapping", () => {
      // 16 cells fits two segments + sep + leading/trailing pad but not all three.
      const out = buildFlexStripLines(
        [seg("alpha"), seg("beta"), seg("gamma")],
        { style: "plain", colorCompatibility: "none", width: 16 },
      );
      const rows = out.split("\n");
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        expect(row.length).toBeLessThanOrEqual(16);
      }
    });

    it("output equals buildLineStrip for width that fits", () => {
      const opts = {
        style: "plain" as const,
        colorCompatibility: "none" as const,
      };
      const segments = [seg("a"), seg("bb"), seg("ccc")];
      const single = buildLineStrip(segments, opts);
      const flex = buildFlexStripLines(segments, { ...opts, width: 200 });
      expect(flex).toBe(single);
    });

    it("empty segment list yields empty string", () => {
      const out = buildFlexStripLines([], {
        style: "plain",
        colorCompatibility: "none",
        width: 80,
      });
      expect(out).toBe("");
    });

    it("never emits a trailing newline", () => {
      const wide = buildFlexStripLines([seg("a")], {
        style: "plain",
        colorCompatibility: "none",
        width: 80,
      });
      const wrapped = buildFlexStripLines([seg("alpha"), seg("beta")], {
        style: "plain",
        colorCompatibility: "none",
        width: 8,
      });
      expect(wide.endsWith("\n")).toBe(false);
      expect(wrapped.endsWith("\n")).toBe(false);
    });
  });

  describe("powerline style", () => {
    it("narrow width breaks across rows with arrow caps on every row", () => {
      const out = buildFlexStripLines([seg("aaa"), seg("bbb"), seg("ccc")], {
        style: "powerline",
        colorCompatibility: "none",
        width: 8,
      });
      const rows = out.split("\n");
      expect(rows.length).toBeGreaterThan(1);
      // PowerlineJoiner end-cap: every row ends with the arrow glyph "".
      for (const row of rows) {
        expect(row.endsWith("\ue0b0")).toBe(true);
      }
    });
  });
});
