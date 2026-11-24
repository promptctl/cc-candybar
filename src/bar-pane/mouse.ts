// The mouse as the bar pane's terminal reports it, and the modes that make it
// report. tmux forwards a pane's mouse events once the pane asks for them.
//
// [LAW:effects-at-boundaries] Pure: the pane (src/bar-pane/index.ts) writes the
// modes and feeds this what stdin delivers.

import {
  BUTTONS,
  MODIFIERS,
  type Button,
  type Gesture,
  type Modifier,
} from "../click/gesture.js";

// Button events (1000), any-motion (1003) and SGR coordinates (1006), which
// have no limit at column 223.
export const MOUSE_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

// A position in the pane, 1-based as the terminal counts.
export interface Cell {
  readonly column: number;
  readonly row: number;
}

// [LAW:types-are-the-program] What a report says happened. A press carries the
// gesture that ran; motion carries no button, because a drag is the pointer
// moving and hover follows the pointer whatever is held.
export type MouseEvent =
  | { readonly kind: "press"; readonly gesture: Gesture; readonly at: Cell }
  | { readonly kind: "motion"; readonly at: Cell }
  | { readonly kind: "release" | "wheel"; readonly at: Cell };

// The report's button number: bits 0-1 the button (3 is none), 4 shift, 8 alt,
// 16 ctrl, 32 motion, 64 wheel.
const MODIFIER_BIT: Readonly<Record<Modifier, number>> = {
  shift: 4,
  alt: 8,
  ctrl: 16,
};
const MOTION_BIT = 32;
const WHEEL_BIT = 64;

// Built from ESC, not written as a literal: a regular expression that names a
// control character is what no-control-regex refuses.
const ESC = "\x1b";
const REPORT = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "y");
// The groups REPORT has, which a match always fills.
type Report = readonly [
  whole: string,
  code: string,
  column: string,
  row: string,
  final: string,
];
// The start of a report not yet whole, kept until the rest arrives.
const PARTIAL = new RegExp(`${ESC}(?:\\[(?:<[\\d;]*)?)?$`);

function eventOf(
  code: number,
  at: Cell,
  final: string,
): MouseEvent | undefined {
  if ((code & WHEEL_BIT) !== 0) return { kind: "wheel", at };
  if ((code & MOTION_BIT) !== 0) return { kind: "motion", at };
  if (final === "m") return { kind: "release", at };
  // [LAW:one-source-of-truth] The terminal numbers the buttons in the order
  // the gestures name them, so no second table says which is which.
  const button: Button | undefined = BUTTONS[code & 3];
  if (button === undefined) return undefined;
  return {
    kind: "press",
    gesture: {
      button,
      modifiers: new Set(
        MODIFIERS.filter((m) => (code & MODIFIER_BIT[m]) !== 0),
      ),
    },
    at,
  };
}

// The events in `input`, and what is left of it: the start of a report whose
// rest has not arrived. Anything else on stdin is not the mouse's and is
// dropped, because the pane takes no keys.
export function readMouse(input: string): {
  readonly events: readonly MouseEvent[];
  readonly rest: string;
} {
  const events: MouseEvent[] = [];
  let at = 0;
  while (at < input.length) {
    REPORT.lastIndex = at;
    const match = REPORT.exec(input) as Report | null;
    if (match === null) {
      const next = input.indexOf("\x1b", at + 1);
      if (next === -1) {
        return { events, rest: PARTIAL.exec(input.slice(at))?.[0] ?? "" };
      }
      at = next;
      continue;
    }
    const [whole, code, column, row, final] = match;
    const event = eventOf(
      Number(code),
      { column: Number(column), row: Number(row) },
      final,
    );
    if (event !== undefined) events.push(event);
    at += whole.length;
  }
  return { events, rest: "" };
}
