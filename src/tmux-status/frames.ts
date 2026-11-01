// The tmux status line lane's encoding of a session's frames (lane C,
// candybar-animation-wbxz.oy3.w5t): each drawn Frame as the rows a tmux status
// line draws — tmux style directives (`#[fg=…]`), not SGR, since a status line
// takes a format, not terminal output — and the links its clickable ranges
// stand for. The daemon's TmuxStatusLines writes the rows into tmux
// (src/daemon/tmux-status.ts); `cc-candybar frames --lane tmuxStatus` shows the
// same encoding.
//
// [LAW:one-source-of-truth] The daemon stays the only renderer: a frame is the
// draw the statusline's bytes are encoded from, as the band lane's frames are
// (src/band/frames.ts).

import { createHash } from "node:crypto";
import { ColorDepth, ColorSpec } from "@promptctl/rich-js";
import {
  laneEncoded,
  mergedRuns,
  type Attribute,
  type Frame,
  type Run,
} from "../render/frame";

// One frame, as a tmux status line draws it: a format per row, and each range
// id a row marks to the link it stands for.
export interface TmuxStatusBar {
  readonly rows: readonly string[];
  readonly links: Readonly<Record<string, string>>;
}

// The prefix of every range id this lane marks, which the status line's click
// binding matches on (`#{m:ccb*,#{mouse_status_range}}`).
export const RANGE_PREFIX = "ccb";
// tmux takes a user range id of at most 15 bytes (tmux(1), STYLES).
const RANGE_HASH_HEX = 15 - RANGE_PREFIX.length;

// [LAW:one-source-of-truth] A link's range id is a digest of its URL, so a
// click on a frame the bar has since moved past finds no link rather than the
// link that now sits at the same place.
export function rangeOf(url: string): string {
  return (
    RANGE_PREFIX +
    createHash("sha256").update(url).digest("hex").slice(0, RANGE_HASH_HEX)
  );
}

// tmux's names for the sixteen colours a terminal's theme draws, in SGR order
// (30–37, then 90–97).
const STANDARD_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightblack",
  "brightred",
  "brightgreen",
  "brightyellow",
  "brightblue",
  "brightmagenta",
  "brightcyan",
  "brightwhite",
] as const;

// [LAW:types-are-the-program] A colour as the frame drew it: the terminal's
// own where it named none (tmux's `terminal`, not `default`, which is the
// status line's style), one of its sixteen or its 256-colour palette by
// number, so the terminal's theme draws them as it draws the statusline's, and
// a truecolor value as itself.
function tmuxColor(drawn: string | undefined): string {
  if (drawn === undefined) return "terminal";
  const spec = ColorSpec.parse(drawn);
  if (spec.isDefault) return "terminal";
  switch (spec.type) {
    case ColorDepth.STANDARD: {
      const name =
        spec.number === undefined ? undefined : STANDARD_NAMES[spec.number];
      if (name !== undefined) return name;
      break;
    }
    case ColorDepth.EIGHT_BIT:
      if (spec.number !== undefined) return `colour${spec.number}`;
      break;
    case ColorDepth.TRUECOLOR: {
      const fixed = spec.fixedValue;
      if (fixed !== undefined) return fixed.hex;
      break;
    }
    case ColorDepth.DEFAULT:
    case ColorDepth.WINDOWS:
      break;
  }
  throw new Error(`frames: no tmux colour for ${spec.name}`);
}

// Every text attribute a Run can hold, and tmux's name for it; null where tmux
// has none, which the lane refuses rather than drawing it some other way.
// [LAW:one-source-of-truth] Keyed by the Run's own `Attribute`, as the band's
// table is: an attribute rich-js adds fails to compile here until the lane
// says how tmux draws it.
const ATTRIBUTES = {
  bold: "bold",
  dim: "dim",
  italic: "italics",
  underline: "underscore",
  strike: "strikethrough",
  reverse: "reverse",
  blink: "blink",
  conceal: "hidden",
  underline2: "double-underscore",
  overline: "overline",
  blink2: null,
  frame: null,
  encircle: null,
} as const satisfies Record<Attribute, string | null>;

// tmux reads `#` as the start of a directive in what it draws, and `##` as a
// `#` (measured, tmux 3.6a: a user option's value is not expanded again as a
// format, but its `#[…]` directives are drawn).
function escaped(text: string): string {
  return text.replaceAll("#", "##");
}

// A run's whole style, from nothing: `none` clears the attributes the run
// before it set, so each run reads alone.
function directive({ fg, bg, attrs = [] }: Run): string {
  const attributes = attrs.map((name) => {
    const tmux = ATTRIBUTES[name];
    if (tmux === null)
      throw new Error(`frames: a tmux status line cannot draw ${name} text`);
    return tmux;
  });
  return `#[${["none", `fg=${tmuxColor(fg)}`, `bg=${tmuxColor(bg)}`, ...attributes].join(",")}]`;
}

// A linked run is a range whose id names its link.
function encode(frame: Frame): TmuxStatusBar {
  const links: Record<string, string> = {};
  const drawn = (run: Run): string => {
    const text = directive(run) + escaped(run.text);
    if (run.link === undefined) return text;
    const range = rangeOf(run.link);
    links[range] = run.link;
    return `#[range=user|${range}]${text}#[norange]`;
  };
  const rows = frame.rows.map((row) => mergedRuns(row).map(drawn).join(""));
  return { rows, links };
}

// One drawn bar as the rows a status line draws.
export function tmuxStatusFrame(frame: Frame): TmuxStatusBar {
  return laneEncoded(encode, frame);
}
