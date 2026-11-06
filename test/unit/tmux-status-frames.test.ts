// The tmux status line lane's frames (src/tmux-status/frames.ts): a drawn bar
// as tmux style directives a status line draws, and the links its ranges stand
// for.

import { tmuxStatusFrame } from "../../src/tmux-status/frames";
import { LinkIds, RANGE_PREFIX } from "../../src/tmux-status/link-ids";
import { barOf } from "../helpers/drawn-frame";
import { countedIds, freshLinkIds } from "../helpers/link-ids";

const encoded = (bar: ReturnType<typeof barOf>) =>
  tmuxStatusFrame(bar, freshLinkIds());

describe("tmuxStatusFrame", () => {
  test("each run is a whole style of its own, and a run with no look the terminal's colours", () => {
    const { rows } = encoded(
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
    const { rows } = encoded(
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
    const { rows } = encoded(barOf([{ text: "#[fg=red]##{pane_id}" }]));
    expect(rows).toEqual(["#[none,fg=terminal,bg=terminal]##[fg=red]####{pane_id}"]);
  });

  test("a linked run is a range named by the link id its table minted, and the table maps it back", () => {
    const url = "cc-candybar://copy/hello";
    const { rows, links } = tmuxStatusFrame(
      barOf([{ text: "a" }, { text: "b", link: url }]),
      new LinkIds(countedIds(35)),
    );
    const range = `${RANGE_PREFIX}z`;
    expect(rows).toEqual([
      `#[none,fg=terminal,bg=terminal]a#[range=user|${range}]#[none,fg=terminal,bg=terminal]b#[norange]`,
    ]);
    expect(links).toEqual({ [range]: url });
  });

  test("the largest id the counter issues still fits tmux's 15-byte range id", () => {
    const { links } = tmuxStatusFrame(
      barOf([{ text: "a", link: "cc-candybar://copy/x" }]),
      new LinkIds(countedIds(999_999_999_999_999 + 1024)),
    );
    const [range] = Object.keys(links);
    expect(Buffer.byteLength(range!)).toBeLessThanOrEqual(15);
  });

  test("one link over neighbouring runs of one look is one range", () => {
    const link = "cc-candybar://copy/hello";
    const { rows, links } = encoded(
      barOf([
        { text: "a", link },
        { text: "b", link },
      ]),
    );
    const [range] = Object.keys(links);
    expect(rows).toEqual([
      `#[range=user|${range}]#[none,fg=terminal,bg=terminal]ab#[norange]`,
    ]);
  });

  test("two links never share a range", () => {
    const { links } = encoded(
      barOf([
        { text: "a", link: "cc-candybar://copy/a" },
        { text: "b", link: "cc-candybar://copy/b" },
      ]),
    );
    expect(Object.values(links)).toEqual([
      "cc-candybar://copy/a",
      "cc-candybar://copy/b",
    ]);
  });

  test("a link drawn while the counter can issue no id is drawn without a range", () => {
    const ids = countedIds();
    ids.faulted = true;
    const { rows, links } = tmuxStatusFrame(
      barOf([{ text: "b", link: "cc-candybar://copy/hello" }]),
      new LinkIds(ids),
    );
    expect(rows).toEqual(["#[none,fg=terminal,bg=terminal]b"]);
    expect(links).toEqual({});
  });

  test("each row of the bar is a row, a blank one included", () => {
    expect(
      encoded(barOf([{ text: "one" }], [], [{ text: "two" }])).rows,
    ).toHaveLength(3);
  });

  test("text tmux has no attribute for is a frame saying why", () => {
    const { rows } = encoded(barOf([{ text: "framed", attrs: ["frame"] }]));
    expect(rows.join("")).toContain("a tmux status line cannot draw frame text");
  });
});
