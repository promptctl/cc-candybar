// [LAW:behavior-not-structure] What `cc-candybar frames --format band` hands
// the mod: the bar the daemon pushed, as rows of styled runs whose links
// survive, and what the statusline would print when the render was refused.

import {
  ColorDepth,
  Segment,
  Style,
  segmentsToString,
} from "@promptctl/rich-js";
import { bandFrame, bandLine } from "../src/band/frames";
import { runFrames } from "../src/frames-cli";
import { DIAGNOSTIC_ERROR_COLORS } from "../src/render/diagnostic-style";

const ESC = "\x1b";

describe("bandFrame", () => {
  test("a truecolor cell keeps its colours, and a link its href", () => {
    // Written by rich-js's one encoder, as the bar is: each link carries the
    // `id=` its URL derives.
    const cell = { color: "#181825", bgcolor: "#b592e1" };
    const ansi = `${segmentsToString(
      [
        new Segment(" ", new Style(cell)),
        new Segment(
          "🍫",
          new Style({ ...cell, link: "cc-candybar://dispatch/e=x" }),
        ),
        new Segment(" ", new Style(cell)),
      ],
      { colorSystem: ColorDepth.TRUECOLOR, hyperlinks: true },
    )}\n`;
    expect(ansi).toContain(`${ESC}]8;id=`);
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

  test.each([
    ["conceal", 8],
    ["blink", 5],
    ["overline", 53],
  ])("refuses %s text, which the mod's Text cannot draw", (name, sgr) => {
    expect(() => bandFrame(`${ESC}[${sgr}mx`)).toThrow(
      `the band cannot draw ${name} text`,
    );
  });
});

test("an unknown --format is refused with exit 2 and the choices, as the other usage errors are", async () => {
  const exit = jest.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  const stderr = jest
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  try {
    await expect(
      runFrames(
        ["node", "cc-candybar", "frames", "--lane", "band", "--format", "ansi"],
        "/opt/cc/dist/index.mjs",
      ),
    ).rejects.toThrow("exit 2");
    expect(String(stderr.mock.calls[0]?.[0])).toBe(
      'cc-candybar frames: --format must be one of response, band, got "ansi"\n',
    );
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
  }
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

  test("the band's lane switched off is the off line, carrying the daemon's sentence", () => {
    expect(
      JSON.parse(
        bandLine({ ok: false, code: "SWITCHED_OFF", error: "🧪 band (A) is off" }),
      ),
    ).toEqual({ kind: "off", reason: "🧪 band (A) is off" });
  });

  test("an empty bar is a bar, never the lane switched off", () => {
    expect(JSON.parse(bandLine({ ok: true, output: "" }))).toEqual({ kind: "bar", rows: [] });
  });

  test("a refused render draws the statusline's error glyph", () => {
    expect(
      textOf(bandLine({ ok: false, code: "RENDER_FAILED", error: "boom" })),
    ).toContain("boom");
  });

  test("an ok response with no bar is the statusline's malformed glyph, not a blank band", () => {
    expect(textOf(bandLine({ ok: true } as never))).not.toBe("");
  });

  test("a bar the band cannot draw is a frame saying why, in the diagnostic colours", () => {
    expect(
      JSON.parse(bandLine({ ok: true, output: `${ESC}[5mx${ESC}[0m\n` })).rows,
    ).toEqual([
      [
        {
          text: "⚠ cc-candybar frames: the band cannot draw blink text",
          color: DIAGNOSTIC_ERROR_COLORS.fg,
          backgroundColor: DIAGNOSTIC_ERROR_COLORS.bg,
        },
      ],
    ]);
  });
});
