// [LAW:behavior-not-structure] What the daemon sends a band-lane subscriber
// (src/daemon/lane-frames.ts) for the mod to draw: the bar it pushed, as rows
// of styled runs whose links survive, and what the statusline would print when
// the render was refused. The other lanes get the frame as the feed sent it.

import {
  ColorDepth,
  Segment,
  Style,
  segmentsToString,
} from "@promptctl/rich-js";
import { bandFrame, bandResponse } from "../src/band/frames";
import { LANE_FRAMES } from "../src/daemon/lane-frames";
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
      { colorSystem: ColorDepth.TRUECOLOR, hyperlinks: true, reducedMotion: false },
    )}\n`;
    expect(ansi).toContain(`${ESC}]8;id=`);
    expect(bandFrame(ansi).band).toEqual([
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
    expect(bandFrame(ansi).band).toEqual([
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
    expect(bandFrame(ansi).band).toEqual([
      [{ text: "x", color: "red", backgroundColor: "blueBright" }],
    ]);
  });

  test("a 256-colour cube entry draws as its fixed colour", () => {
    expect(bandFrame(`${ESC}[38;5;196mx`).band).toEqual([
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

describe("bandResponse", () => {
  const textOf = (bar: ReturnType<typeof bandResponse>): string =>
    bar.band.map((row) => row.map((r) => r.text).join("")).join("\n");

  test("a pushed bar is its rows", () => {
    expect(bandResponse({ ok: true, output: "a\nb\n" })).toEqual(
      bandFrame("a\nb\n"),
    );
  });

  test("an empty bar is a bar, never the lane switched off", () => {
    expect(bandResponse({ ok: true, output: "" })).toEqual({ ok: true, band: [] });
  });

  test("a refused render draws the statusline's error glyph", () => {
    expect(
      textOf(bandResponse({ ok: false, code: "RENDER_FAILED", error: "boom" })),
    ).toContain("boom");
  });

  test("an ok response with no bar is the statusline's malformed glyph, not a blank band", () => {
    expect(textOf(bandResponse({ ok: true } as never))).not.toBe("");
  });

  test("a bar the band cannot draw is a frame saying why, in the diagnostic colours", () => {
    expect(
      bandResponse({ ok: true, output: `${ESC}[5mx${ESC}[0m\n` }).band,
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

describe("LANE_FRAMES", () => {
  const resp = { ok: true, output: "a\n" } as const;
  const json = JSON.stringify(resp);

  test("a band-lane subscriber receives the bar as its rows of runs", () => {
    expect(JSON.parse(LANE_FRAMES.band(resp, json))).toEqual(bandResponse(resp));
  });

  test("the statusline and pane lanes receive the frame as the feed serialized it", () => {
    expect(LANE_FRAMES.statusline(resp, json)).toBe(json);
    expect(LANE_FRAMES.pane(resp, json)).toBe(json);
  });
});
