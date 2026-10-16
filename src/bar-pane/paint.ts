// A frame of the bar, as the bytes that redraw a pane holding nothing else.
//
// [LAW:effects-at-boundaries] Pure: the loop (src/bar-pane/index.ts) writes the
// bytes and sizes the pane to `rows`; this only decides what they are.

export interface Paint {
  readonly bytes: string;
  // The pane height that shows the frame whole — one row per bar line.
  readonly rows: number;
}

const HOME = "\x1b[H";
const ERASE_LINE = "\x1b[2K";
const ERASE_BELOW = "\x1b[J";

// Each line is erased before it is written rather than after: an erase issued
// at the right margin, with the cursor waiting to wrap, would take the line's
// last cell with it. The last line ends without a newline, so a frame exactly
// as tall as the pane never scrolls it.
export function paint(frame: string): Paint {
  const lines = frame.replace(/\n+$/, "").split("\n");
  return {
    bytes:
      HOME + lines.map((line) => ERASE_LINE + line).join("\r\n") + ERASE_BELOW,
    rows: lines.length,
  };
}
