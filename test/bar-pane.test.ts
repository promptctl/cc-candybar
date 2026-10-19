// `cc-candybar bar-pane` (src/bar-pane): what it paints, where it stands in
// tmux, and the arguments it takes. The frames themselves are the daemon's push,
// covered by test/frame-feed.test.ts and test/daemon-frame-feed-e2e.test.ts.

import { parseArgs, placementFrom } from "../src/bar-pane";
import { paint } from "../src/bar-pane/paint";

describe("bar-pane paint", () => {
  it("places each bar line on its own row and erases what is below", () => {
    expect(paint("row one\nrow two")).toEqual({
      bytes: "\x1b[1H\x1b[2Krow one\x1b[2H\x1b[2Krow two\x1b[J",
      rows: 2,
    });
  });

  // A newline at the pane's bottom row would scroll its first line away.
  it("writes no newline, whatever newlines the frame ends with", () => {
    expect(paint("only\n\n")).toEqual(paint("only"));
    expect(paint("a\nb\nc").bytes).not.toMatch(/[\r\n]/);
  });
});

// tmux's `list-panes` lines: pane id, sessions attached, window active, window
// zoomed, pane active.
describe("bar-pane placement", () => {
  const at = (...lines: string[]): string => `${lines.join("\n")}\n`;

  it("is shown while its window is the active one of an attached session", () => {
    expect(placementFrom(at("%3 1 1 0 1", "%4 1 1 0 0"), "%3", "%4")).toEqual({
      kind: "shown",
      zoomed: false,
    });
  });

  it("is hidden in an inactive window or a detached session", () => {
    expect(placementFrom(at("%3 1 0 0 1", "%4 1 0 0 0"), "%3", "%4")).toEqual({
      kind: "hidden",
    });
    expect(placementFrom(at("%3 0 1 0 1", "%4 0 1 0 0"), "%3", "%4")).toEqual({
      kind: "hidden",
    });
  });

  // A zoom shows one pane: the bar pane behind another's zoom is drawn for
  // nobody, and one that is itself the zoomed pane must not be resized, which
  // would unzoom it.
  it("is hidden behind another pane's zoom, and shown but zoomed as the zoomed pane", () => {
    expect(placementFrom(at("%3 1 1 1 1", "%4 1 1 1 0"), "%3", "%4")).toEqual({
      kind: "hidden",
    });
    expect(placementFrom(at("%3 1 1 1 0", "%4 1 1 1 1"), "%3", "%4")).toEqual({
      kind: "shown",
      zoomed: true,
    });
  });

  it("is shown when any session holding a linked window shows it", () => {
    expect(
      placementFrom(at("%3 0 1 0 1", "%4 0 1 0 0", "%3 1 1 0 1", "%4 1 1 0 0"), "%3", "%4"),
    ).toEqual({ kind: "shown", zoomed: false });
  });

  it("is gone once tmux no longer lists the session's pane", () => {
    expect(placementFrom(at("%4 1 1 0 1"), "%3", "%4")).toEqual({ kind: "gone" });
  });
});

describe("bar-pane arguments", () => {
  it("take one pane id", () => {
    expect(parseArgs(["%3"])).toEqual({ pane: "%3" });
  });

  it.each([[[]], [["3"]], [["%3", "%4"]], [["%3", "--fps", "20"]]])(
    "refuse %j with the usage line",
    (argv) => {
      expect(() => parseArgs(argv)).toThrow(/usage: cc-candybar bar-pane/);
    },
  );
});
