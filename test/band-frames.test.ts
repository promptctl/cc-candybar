// [LAW:behavior-not-structure] What the daemon sends a band-lane subscriber
// (src/daemon/lane-frames.ts) for the mod to draw: a drawn Frame as rows of
// styled runs whose links survive, and a frame saying why when the band cannot
// draw it. The other lanes get the frame as the feed sent it.

import type { Attribute } from "../src/render/frame";
import { bandFrame } from "../src/band/frames";
import { LANE_FRAMES } from "../src/daemon/lane-frames";
import { DIAGNOSTIC_ERROR_COLORS } from "../src/render/diagnostic-style";
import { laneEncoded, renderFailedFrame } from "../src/render/frame";
import { barOf } from "./helpers/drawn-frame";

describe("bandFrame", () => {
  test("a truecolor cell keeps its colours, and a link its href", () => {
    const look = { fg: "#181825", bg: "#b592e1" };
    expect(
      bandFrame(
        barOf([
          { text: " ", ...look },
          { text: "🍫", ...look, link: "cc-candybar://dispatch/e=x" },
          { text: " ", ...look },
        ]),
      ).band,
    ).toEqual([
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

  test("each row is a row, a run with no look is plain, and a blank row stays one", () => {
    const attrs: Attribute[] = [
      "bold",
      "dim",
      "italic",
      "underline",
      "strike",
      "reverse",
    ];
    expect(
      bandFrame(
        barOf(
          [{ text: "a " }, { text: "b", attrs }, { text: " c" }],
          [],
          [{ text: "d" }],
        ),
      ).band,
    ).toEqual([
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
      [],
      [{ text: "d" }],
    ]);
  });

  test("an empty bar is a bar, never the lane switched off", () => {
    expect(bandFrame(barOf())).toEqual({ ok: true, band: [] });
  });

  test("the sixteen terminal colours stay names its theme draws, however they are spelled", () => {
    expect(
      bandFrame(
        barOf([
          { text: "x", fg: "red", bg: "bright_blue" },
          { text: "y", fg: "color(1)", bg: "color(12)" },
        ]),
      ).band,
    ).toEqual([
      [
        { text: "x", color: "red", backgroundColor: "blueBright" },
        { text: "y", color: "red", backgroundColor: "blueBright" },
      ],
    ]);
  });

  test("a 256-colour cube entry draws as its fixed colour", () => {
    expect(bandFrame(barOf([{ text: "x", fg: "color(196)" }])).band).toEqual([
      [{ text: "x", color: "#ff0000" }],
    ]);
  });

  test("the terminal's own colour names no colour", () => {
    expect(
      bandFrame(barOf([{ text: "x", fg: "default", bg: "default" }])).band,
    ).toEqual([[{ text: "x" }]]);
  });

  test("neighbouring runs of one look are one run, and any difference in look keeps them apart", () => {
    const look = { fg: "#181825", attrs: ["bold"] as Attribute[] };
    expect(
      bandFrame(
        barOf([
          { text: "a", ...look },
          { text: "b", ...look },
          { text: "c", ...look, bg: "#b592e1" },
          { text: "d", ...look, link: "cc-candybar://copy/d" },
          { text: "e", ...look, link: "cc-candybar://copy/d" },
          { text: "f", ...look, attrs: ["italic"] },
        ]),
      ).band[0]!.map((run) => run.text),
    ).toEqual(["ab", "c", "de", "f"]);
  });

  test.each(["conceal", "blink", "overline"] as const)(
    "refuses %s text, which the mod's Text cannot draw",
    (name) => {
      expect(() =>
        bandFrame(barOf([{ text: "x", attrs: [name] }])),
      ).toThrow(`the band cannot draw ${name} text`);
    },
  );
});

describe("the lane's refusal", () => {
  test("a bar the band cannot draw is a frame saying why, in the diagnostic colours", () => {
    expect(
      laneEncoded(bandFrame, barOf([{ text: "x", attrs: ["blink"] }])).band,
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
  const bar = barOf([{ text: "a" }]);
  const json = JSON.stringify({ ok: true, output: "a\n" });

  test("a band-lane subscriber receives the bar as its rows of runs", () => {
    expect(JSON.parse(LANE_FRAMES.band(bar, json))).toEqual(bandFrame(bar));
  });

  test("a band-lane subscriber receives a failed render as the statusline's error glyph", () => {
    expect(LANE_FRAMES.band(renderFailedFrame("boom"), json)).toContain(
      "render failed: boom",
    );
  });

  test("a bar the band cannot draw goes out as the frame saying why, never a throw", () => {
    expect(
      LANE_FRAMES.band(barOf([{ text: "x", attrs: ["blink"] }]), json),
    ).toContain("the band cannot draw blink text");
  });

  test("the statusline and pane lanes receive the frame as the feed serialized it", () => {
    expect(LANE_FRAMES.statusline(bar, json)).toBe(json);
    expect(LANE_FRAMES.pane(bar, json)).toBe(json);
  });
});
