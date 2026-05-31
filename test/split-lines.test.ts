// [LAW:behavior-not-structure] Unit tests for the cell→line primitive. The
// contract: partition a cell stream into per-line cell groups on the "\n"
// sentinel, consume the sentinel (never emit it), preserve spans, pass a
// newline-free cell through BY REFERENCE, and yield one (empty) line for an
// empty input.

import { RichText, Style } from "@promptctl/rich-js";
import { splitCellsIntoLines } from "../src/render/split-lines";

// Join a line group's cell texts so assertions read in terms of content.
const text = (group: RichText[]): string => group.map((c) => c.plain).join("");

describe("splitCellsIntoLines", () => {
  test("newline-free cells pass through by reference as one line", () => {
    const a = new RichText("a");
    const b = new RichText("b");
    const lines = splitCellsIntoLines([a, b]);
    expect(lines).toHaveLength(1);
    // Same references — the common path allocates nothing new.
    expect(lines[0]![0]).toBe(a);
    expect(lines[0]![1]).toBe(b);
  });

  test("a cell carrying \\n splits into two line groups; \\n is consumed", () => {
    const lines = splitCellsIntoLines([new RichText("TOP\nBOT")]);
    expect(lines).toHaveLength(2);
    expect(text(lines[0]!)).toBe("TOP");
    expect(text(lines[1]!)).toBe("BOT");
    // The sentinel never survives into a line's text.
    expect(text(lines[0]!)).not.toContain("\n");
    expect(text(lines[1]!)).not.toContain("\n");
  });

  test("interior \\n closes the current line and the rest starts the next", () => {
    // [A]["B\nC"][D] → line0 = A,B ; line1 = C,D
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
    // Both pieces retain the base color (carried through slice).
    expect(lines[0]![0]!.style.color).toBeDefined();
    expect(lines[1]![0]!.style.color).toBeDefined();
  });
});
