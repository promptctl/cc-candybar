// The tmux status line lane's frames (src/tmux-status/frames.ts): a rendered
// bar as tmux style directives a status line draws, and the links its ranges
// stand for.

import {
  RANGE_PREFIX,
  rangeOf,
  tmuxStatusFrame,
  tmuxStatusResponse,
} from "../src/tmux-status/frames";

const ESC = "\x1b";
const link = (url: string, text: string): string =>
  `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;

describe("tmuxStatusFrame", () => {
  test("each run is a whole style of its own, and plain text the terminal's colours", () => {
    const { rows } = tmuxStatusFrame(
      `${ESC}[1;38;2;255;0;0;48;5;42mhot${ESC}[0m cold${ESC}[31;4mx${ESC}[0m\n`,
    );
    expect(rows).toEqual([
      "#[none,fg=#ff0000,bg=colour42,bold]hot" +
        "#[none,fg=terminal,bg=terminal] cold" +
        "#[none,fg=red,bg=terminal,underscore]x",
    ]);
  });

  test("a # in the text is drawn as one, never read as a directive", () => {
    const { rows } = tmuxStatusFrame("#[fg=red]##{pane_id}\n");
    expect(rows).toEqual(["#[none,fg=terminal,bg=terminal]##[fg=red]####{pane_id}"]);
  });

  test("a linked run is a range named by its link's digest, and the table maps it back", () => {
    const url = "cc-candybar://copy/hello";
    const { rows, links } = tmuxStatusFrame(`a${link(url, "b")}\n`);
    const range = rangeOf(url);
    expect(range.startsWith(RANGE_PREFIX)).toBe(true);
    expect(Buffer.byteLength(range)).toBeLessThanOrEqual(15);
    expect(rows).toEqual([
      `#[none,fg=terminal,bg=terminal]a#[range=user|${range}]#[none,fg=terminal,bg=terminal]b#[norange]`,
    ]);
    expect(links).toEqual({ [range]: url });
  });

  test("each line of the bar is a row", () => {
    expect(tmuxStatusFrame("one\ntwo\n").rows).toHaveLength(2);
  });

  test("text tmux has no attribute for is refused, and the response says why in a frame", () => {
    expect(() => tmuxStatusFrame(`${ESC}[51mframed${ESC}[0m\n`)).toThrow(
      "a tmux status line cannot draw frame text",
    );
    const { rows } = tmuxStatusResponse({
      ok: true,
      output: `${ESC}[51mframed${ESC}[0m\n`,
    });
    expect(rows.join("")).toContain("a tmux status line cannot draw frame text");
  });
});
