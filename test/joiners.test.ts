import { JOINERS, cellLen } from "@promptctl/rich-js";
import {
  buildLineStrip,
  stripChromeCols,
  stripSeamCols,
} from "../src/render/strip";
import { ENDCAPS_SHAPES, type Endcaps } from "../src/themes/policy";
import { resolveOptionDomain } from "../src/config/option-domain";
import { stripAnsi } from "./helpers/ansi";

// candybar-joiners-la5z: endcaps choose among rich-js's named joiners.

const cells = [
  { type: "x", text: "aaa", bgHex: "#203040", fgHex: "#ffffff" },
  { type: "x", text: "bbb", bgHex: "#a05030", fgHex: "#ffffff" },
];
const row = (endcaps: Endcaps, separator?: string): string =>
  buildLineStrip(cells, {
    endcaps,
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
    test("the row costs the chrome and seam the strip measures for it", () => {
      const width = cellLen(stripAnsi(row(endcaps)));
      const content = cells.reduce((sum, c) => sum + c.text.length + 2, 0);
      expect(width).toBe(
        content + stripChromeCols({ endcaps }) + stripSeamCols({ endcaps }),
      );
    });
  });

  test("plain draws the authored separator as written", () => {
    expect(stripAnsi(row("plain", " :: "))).toBe(" aaa  ::  bbb ");
    expect(stripAnsi(row("plain", " │ "))).toBe(" aaa  │  bbb ");
  });

  test("plain's separator and metro's rail are the terminal's own text, not a palette slot", () => {
    expect(row("plain", " | ")).toContain("\x1b[39m | ");
    expect(row("metro")).toMatch(/\x1b\[39m[^\x1b]+\x1b\[0m/);
  });
});
