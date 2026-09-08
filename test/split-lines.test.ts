// [LAW:behavior-not-structure] The contract: split on the "\n" sentinel, consume
// it, preserve spans, and pass a newline-free cell through BY REFERENCE.

import { RichText, Style } from "@promptctl/rich-js";
import { splitCellsIntoLines } from "../src/render/split-lines";

const text = (group: RichText[]): string => group.map((c) => c.plain).join("");

describe("splitCellsIntoLines", () => {
  test("newline-free cells pass through by reference as one line", () => {
    const a = new RichText("a");
    const b = new RichText("b");
    const lines = splitCellsIntoLines([a, b]);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toBe(a);
    expect(lines[0]![1]).toBe(b);
  });

  test("a cell carrying \\n splits into two line groups; \\n is consumed", () => {
    const lines = splitCellsIntoLines([new RichText("TOP\nBOT")]);
    expect(lines).toHaveLength(2);
    expect(text(lines[0]!)).toBe("TOP");
    expect(text(lines[1]!)).toBe("BOT");
    expect(text(lines[0]!)).not.toContain("\n");
    expect(text(lines[1]!)).not.toContain("\n");
  });

  test("interior \\n closes the current line and the rest starts the next", () => {
    const lines = splitCellsIntoLines([
      new RichText("A"),
      new RichText("B\nC"),
      new RichText("D"),
    ]);
    expect(lines).toHaveLength(2);
    expect(text(lines[0]!)).toBe("AB");
    expect(text(lines[1]!)).toBe("CD");
  });

  test("multiple \\n in one cell yield interior whole lines", () => {
    const lines = splitCellsIntoLines([new RichText("a\nb\nc")]);
    expect(lines.map(text)).toEqual(["a", "b", "c"]);
  });

  test("leading and trailing \\n produce empty boundary lines", () => {
    expect(splitCellsIntoLines([new RichText("\nx")]).map(text)).toEqual([
      "",
      "x",
    ]);
    expect(splitCellsIntoLines([new RichText("x\n")]).map(text)).toEqual([
      "x",
      "",
    ]);
  });

  test("empty input yields exactly one empty line (not zero)", () => {
    const lines = splitCellsIntoLines([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([]);
  });

  test("split preserves the cell's style (span-preserving slice)", () => {
    const styled = new RichText("up\ndn", {
      style: new Style({ color: "#ff0000" }),
    });
    expect(styled.style.color).toBeDefined();
    const lines = splitCellsIntoLines([styled]);
    expect(lines).toHaveLength(2);
    expect(text(lines[0]!)).toBe("up");
    expect(text(lines[1]!)).toBe("dn");
    expect(lines[0]![0]!.style.color).toBeDefined();
    expect(lines[1]![0]!.style.color).toBeDefined();
  });
});
