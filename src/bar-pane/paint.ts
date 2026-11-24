// A frame of the bar, as the bytes that redraw a pane holding nothing else.
//
// [LAW:effects-at-boundaries] Pure: the loop (src/bar-pane/index.ts) writes the
// bytes and sizes the pane to `rows`; this only decides what they are.

import { MOUSE_OFF, MOUSE_ON } from "./mouse.js";

export interface Paint {
  readonly bytes: string;
  // The pane height that shows the frame whole — one row per bar line.
  readonly rows: number;
}

// The pane's terminal while the bar is drawn in it, and as it is left: the
// cursor hidden, and autowrap off, so a line wider than the pane clips at its
// edge instead of taking a second row. The mouse is reported to the pane while
// it draws, which also stops the terminal opening a link a click lands on: the
// pane delivers it (src/bar-pane/index.ts).
export const DRAWING = "\x1b[?25l\x1b[?7l" + MOUSE_ON;
export const RESTORED = MOUSE_OFF + "\x1b[?25h\x1b[?7h";

// Synchronized output: the terminal shows the whole frame at once.
const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
// A row's erase takes the current background, so it follows a reset.
const ERASE_RIGHT = "\x1b[0m\x1b[K";
const ERASE_BELOW = "\x1b[J";

// [LAW:one-source-of-truth] The lines a frame paints: its trailing blank lines
// are not drawn, so a hit map is cut to this count to describe what shows.
export const paintedLines = (frame: string): string[] =>
  frame.replace(/\n+$/, "").split("\n");

// Each line is placed on its own row by cursor position and no newline is
// ever written, so no frame scrolls the pane, whatever height tmux granted it:
// in a pane shorter than the frame, the rows past its bottom land on its last
// row, and the first rows stay where they are. A row is overwritten and only
// its remainder erased, because a row erased first shows blank until its text
// lands, and an animated bar repaints every row on every frame.
export function paint(frame: string): Paint {
  const lines = paintedLines(frame);
  return {
    bytes:
      FRAME_START +
      lines.map((line, i) => `\x1b[${i + 1}H${line}${ERASE_RIGHT}`).join("") +
      ERASE_BELOW +
      FRAME_END,
    rows: lines.length,
  };
}

// [LAW:one-source-of-truth] Which frame line the pane shows on a terminal row
// (1-based), as paint places them: line i at row i + 1, and the rows past the
// pane's bottom land on its last row, which so shows the frame's last line.
// The hit test asks here, so a press lands on the line the user saw. Null for a
// row below the frame, which is blank.
export function lineAtRow(
  row: number,
  paneRows: number,
  lines: number,
): number | null {
  const last = lines - 1;
  if (row === paneRows && lines > paneRows) return last;
  return row - 1 <= last ? row - 1 : null;
}
