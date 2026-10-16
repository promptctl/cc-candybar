// A frame of the bar, as the bytes that redraw a pane holding nothing else.
//
// [LAW:effects-at-boundaries] Pure: the loop (src/bar-pane/index.ts) writes the
// bytes and sizes the pane to `rows`; this only decides what they are.

export interface Paint {
  readonly bytes: string;
  // The pane height that shows the frame whole — one row per bar line.
  readonly rows: number;
}

// The pane's terminal while the bar is drawn in it, and as it is left: the
// cursor hidden, and autowrap off, so a line wider than the pane clips at its
// edge instead of taking a second row.
export const DRAWING = "\x1b[?25l\x1b[?7l";
export const RESTORED = "\x1b[?25h\x1b[?7h";

const ERASE_LINE = "\x1b[2K";
const ERASE_BELOW = "\x1b[J";

// Each line is placed on its own row by cursor position and no newline is
// ever written, so no frame scrolls the pane, whatever height tmux granted it:
// in a pane shorter than the frame, the rows past its bottom land on its last
// row, and the first rows stay where they are.
export function paint(frame: string): Paint {
  const lines = frame.replace(/\n+$/, "").split("\n");
  return {
    bytes:
      lines.map((line, i) => `\x1b[${i + 1}H${ERASE_LINE}${line}`).join("") +
      ERASE_BELOW,
    rows: lines.length,
  };
}
