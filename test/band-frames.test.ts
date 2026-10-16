// [LAW:behavior-not-structure] What `cc-candybar frames --format band` hands
// the mod: the bar the daemon pushed, as rows of styled runs whose links
// survive, and what the statusline would print when the render was refused.

import { bandFrame, bandLine } from "../src/band/frames";
const ESC = "\x1b";
const link = (url: string, text: string) =>
  `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;

describe("bandFrame", () => {
  test("a truecolor cell keeps its colours, and a link its href", () => {
    const ansi = `${ESC}[38;2;24;24;37;48;2;181;146;225m ${link(
      "cc-candybar://dispatch/e=x",
      "🍫",
    )} ${ESC}[0m\n`;
    expect(bandFrame(ansi).rows).toEqual([
      [
        { text: " ", color: "#181825", backgroundColor: "#b592e1" },
        {
          text: "🍫",
          color: "#181825",
          backgroundColor: "#b592e1",
          href: "cc-candybar://dispatch/e=x",
        },
        { text: " ", color: "#181825", backgroundColor: "#b592e1" },
      ],
    ]);
  });

  test("each line is a row, text outside any style is plain", () => {
    const ansi = `a ${ESC}[1;3;4;9;2;7mb${ESC}[0m c\nd\n`;
    expect(bandFrame(ansi).rows).toEqual([
      [
        { text: "a " },
        {
          text: "b",
          bold: true,
          italic: true,
          underline: true,
          strikethrough: true,
          dimColor: true,
          inverse: true,
        },
        { text: " c" },
      ],
      [{ text: "d" }],
    ]);
  });

  test("the sixteen terminal colours stay names its theme draws", () => {
    const ansi = `${ESC}[31;104mx${ESC}[0m`;
    expect(bandFrame(ansi).rows).toEqual([
      [{ text: "x", color: "red", backgroundColor: "blueBright" }],
    ]);
  });

  test("a 256-colour cube entry draws as its fixed colour", () => {
    expect(bandFrame(`${ESC}[38;5;196mx`).rows).toEqual([
      [{ text: "x", color: "#ff0000" }],
    ]);
  });
});

describe("bandLine", () => {
  const textOf = (line: string): string =>
    JSON.parse(line)
      .rows.map((row: { text: string }[]) => row.map((r) => r.text).join(""))
      .join("\n");

  test("a pushed bar is its rows", () => {
    expect(JSON.parse(bandLine({ ok: true, output: "a\nb\n" }))).toEqual(
      bandFrame("a\nb\n"),
    );
  });

  test("a refused render draws the statusline's error glyph", () => {
    expect(
      textOf(bandLine({ ok: false, code: "RENDER_FAILED", error: "boom" })),
    ).toContain("boom");
  });

  test("an ok response with no bar is the statusline's malformed glyph, not a blank band", () => {
    expect(textOf(bandLine({ ok: true } as never))).not.toBe("");
  });
});
