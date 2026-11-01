import { plainOf, type Run } from "../src/render/frame";
import { JOINERS, cellLen } from "@promptctl/rich-js";
import {
  drawStripCells,
  stripChromeCols,
  stripSeamCols,
} from "../src/render/strip";
import { ENDCAPS_SHAPES, type Endcaps } from "../src/themes/policy";
import { resolveOptionDomain } from "../src/config/option-domain";
import { stripCell } from "./helpers/strip-cell";

// candybar-joiners-la5z: endcaps choose among rich-js's named joiners.

const PADDING = 1;
const cells = [
  { text: "aaa", bgHex: "#203040", fgHex: "#ffffff" },
  { text: "bbb", bgHex: "#a05030", fgHex: "#ffffff" },
];
const row = (endcaps: Endcaps, separator?: string): readonly Run[] =>
  drawStripCells(
    cells.map((cell) => stripCell(cell, PADDING)),
    {
      endcaps,
      separator,
      colorCompatibility: "truecolor",
      wrap: false,
      padding: PADDING,
      width: Number.POSITIVE_INFINITY,
    },
  ).lines.flat();

describe("endcaps are rich-js's named joiners", () => {
  test("the endcaps vocabulary and its option domain are exactly JOINERS' names", () => {
    expect([...ENDCAPS_SHAPES]).toEqual(Object.keys(JOINERS));
    expect([...resolveOptionDomain("endcaps", new Map()).members]).toEqual(Object.keys(JOINERS));
  });

  describe.each(ENDCAPS_SHAPES.map((name) => [name]))("%s", (endcaps) => {
    test("the row costs the chrome and seam the strip measures for it", () => {
      const width = cellLen(plainOf(row(endcaps)));
      const content = cells.reduce((sum, c) => sum + c.text.length + 2, 0);
      expect(width).toBe(
        content + stripChromeCols({ endcaps }) + stripSeamCols({ endcaps }),
      );
    });
  });

  test("plain draws the authored separator as written", () => {
    expect(plainOf(row("plain", " :: "))).toBe(" aaa  ::  bbb ");
    expect(plainOf(row("plain", " │ "))).toBe(" aaa  │  bbb ");
  });

  test("plain's separator and metro's rail are the terminal's own text, not a palette slot", () => {
    expect(row("plain", " | ").find(({ text }) => text === " | ")?.fg).toBe("default");
    expect(row("metro").find(({ text }) => text === "──")?.fg).toBe("default");
  });
});
