import { JOINERS } from "@promptctl/rich-js";
import {
  buildLineStrip,
  stripChromeCols,
  stripSeamCols,
  type Charset,
} from "../src/render/strip";
import { ENDCAPS_SHAPES, type Endcaps } from "../src/themes/policy";
import { resolveOptionDomain } from "../src/config/option-domain";
import { stripAnsi } from "./helpers/ansi";

// candybar-joiners-la5z: endcaps choose among rich-js's named joiners.

const PUA = /[\u{E000}-\u{F8FF}]/u;
const cells = [
  { type: "x", text: "aaa", bgHex: "#203040", fgHex: "#ffffff" },
  { type: "x", text: "bbb", bgHex: "#a05030", fgHex: "#ffffff" },
];
const row = (endcaps: Endcaps, charset: Charset, separator?: string): string =>
  buildLineStrip(cells, {
    endcaps,
    charset,
    separator,
    colorCompatibility: "truecolor",
    wrap: false,
    padding: 1,
    width: Number.POSITIVE_INFINITY,
  });

describe("endcaps are rich-js's named joiners", () => {
  test("the endcaps vocabulary and its option domain are exactly JOINERS' names", () => {
    expect([...ENDCAPS_SHAPES]).toEqual(Object.keys(JOINERS));
    expect([...resolveOptionDomain("endcaps", new Map()).members]).toEqual(Object.keys(JOINERS));
  });

  describe.each(ENDCAPS_SHAPES.map((name) => [name]))("%s", (endcaps) => {
    test.each([["unicode"], ["ascii"]] as const)(
      "under %s, the row costs the chrome and seam the strip measures for it",
      (charset) => {
        const width = [...stripAnsi(row(endcaps, charset))].length;
        const content = cells.reduce((sum, c) => sum + c.text.length + 2, 0);
        expect(width).toBe(
          content + stripChromeCols({ endcaps, charset }) + stripSeamCols({ endcaps, charset }),
        );
      },
    );

    test("ascii draws no private-use glyph", () => {
      expect(PUA.test(stripAnsi(row(endcaps, "ascii")))).toBe(false);
    });
  });

  test("plain draws the authored separator under either charset when it is ASCII", () => {
    expect(stripAnsi(row("plain", "unicode", " :: "))).toBe(" aaa  ::  bbb ");
    expect(stripAnsi(row("plain", "ascii", " :: "))).toBe(" aaa  ::  bbb ");
  });

  test("plain with a non-ASCII separator draws plain's own ascii separator under ascii", () => {
    expect(stripAnsi(row("plain", "unicode", " │ "))).toBe(" aaa  │  bbb ");
    expect(PUA.test(stripAnsi(row("plain", "ascii", " │ ")))).toBe(false);
    expect(stripAnsi(row("plain", "ascii", " │ "))).not.toContain("│");
  });
});
