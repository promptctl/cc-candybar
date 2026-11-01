// The tmux status line lane's frames (src/tmux-status/frames.ts): a drawn bar
// as tmux style directives a status line draws, and the links its ranges stand
// for.

import { laneEncoded } from "../src/render/frame";
import {
  RANGE_PREFIX,
  rangeOf,
  tmuxStatusFrame,
} from "../src/tmux-status/frames";
import { barOf } from "./helpers/drawn-frame";

describe("tmuxStatusFrame", () => {
  test("each run is a whole style of its own, and a run with no look the terminal's colours", () => {
    const { rows } = tmuxStatusFrame(
      barOf([
        { text: "hot", fg: "#ff0000", bg: "color(42)", attrs: ["bold"] },
        { text: " cold" },
        { text: "x", fg: "red", attrs: ["underline"] },
      ]),
    );
    expect(rows).toEqual([
      "#[none,fg=#ff0000,bg=colour42,bold]hot" +
        "#[none,fg=terminal,bg=terminal] cold" +
        "#[none,fg=red,bg=terminal,underscore]x",
    ]);
  });

  test("the sixteen stay tmux's names however they are spelled, and the terminal's own colour is `terminal`", () => {
    const { rows } = tmuxStatusFrame(
      barOf([
        { text: "a", fg: "color(9)", bg: "bright_black" },
        { text: "b", fg: "default", bg: "default" },
      ]),
    );
    expect(rows).toEqual([
      "#[none,fg=brightred,bg=brightblack]a#[none,fg=terminal,bg=terminal]b",
    ]);
  });

  test("a # in the text is drawn as one, never read as a directive", () => {
    const { rows } = tmuxStatusFrame(barOf([{ text: "#[fg=red]##{pane_id}" }]));
    expect(rows).toEqual(["#[none,fg=terminal,bg=terminal]##[fg=red]####{pane_id}"]);
  });

  test("a linked run is a range named by its link's digest, and the table maps it back", () => {
    const url = "cc-candybar://copy/hello";
    const { rows, links } = tmuxStatusFrame(
      barOf([{ text: "a" }, { text: "b", link: url }]),
    );
    const range = rangeOf(url);
    expect(range.startsWith(RANGE_PREFIX)).toBe(true);
    expect(Buffer.byteLength(range)).toBeLessThanOrEqual(15);
    expect(rows).toEqual([
      `#[none,fg=terminal,bg=terminal]a#[range=user|${range}]#[none,fg=terminal,bg=terminal]b#[norange]`,
    ]);
    expect(links).toEqual({ [range]: url });
  });

  test("one link over neighbouring runs of one look is one range", () => {
    const link = "cc-candybar://copy/hello";
    const { rows } = tmuxStatusFrame(
      barOf([
        { text: "a", link },
        { text: "b", link },
      ]),
    );
    expect(rows).toEqual([
      `#[range=user|${rangeOf(link)}]#[none,fg=terminal,bg=terminal]ab#[norange]`,
    ]);
  });

  test("each row of the bar is a row, a blank one included", () => {
    expect(
      tmuxStatusFrame(barOf([{ text: "one" }], [], [{ text: "two" }])).rows,
    ).toHaveLength(3);
  });

  test("text tmux has no attribute for is refused, and the lane says why in a frame", () => {
    const framed = barOf([{ text: "framed", attrs: ["frame"] }]);
    expect(() => tmuxStatusFrame(framed)).toThrow(
      "a tmux status line cannot draw frame text",
    );
    const { rows } = laneEncoded(tmuxStatusFrame, framed);
    expect(rows.join("")).toContain("a tmux status line cannot draw frame text");
  });
});
