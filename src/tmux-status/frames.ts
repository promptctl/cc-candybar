// The tmux status line lane's encoding of a session's frames (lane C,
// candybar-animation-wbxz.oy3.w5t): each pushed render response as the rows a
// tmux status line draws — tmux style directives (`#[fg=…]`), not SGR, since
// a status line takes a format, not terminal output — and the links its
// clickable ranges stand for. The daemon's TmuxStatusLines writes the rows
// into tmux (src/daemon/tmux-status.ts); `cc-candybar frames --lane
// tmuxStatus` shows the same encoding.
//
// [LAW:one-source-of-truth] The daemon stays the only renderer: a frame is the
// statusline's own render, classified and planned by the relay's own outcome
// code, decoded by rich-js's own AnsiDecoder, as the band lane's frames are
// (src/band/frames.ts).

import { createHash } from "node:crypto";
import { AnsiDecoder, ColorDepth, Style } from "@promptctl/rich-js";
import type { ColorSpec, StyleOptions } from "@promptctl/rich-js";
import { renderOutcomeOf } from "../daemon/client";
import type { Response } from "../daemon/protocol";
import { DIAGNOSTIC_ERROR_COLORS } from "../render/diagnostic-style";
import { ansiOf, diagnosticFrame } from "../render/frame";
import { planOutcome } from "../render/outcome-plan";

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

// [LAW:types-are-the-program] A colour as the escape drew it: the terminal's
// own where it named none (tmux's `terminal`, not `default`, which is the
// status line's style), one of its sixteen or its 256-colour palette by
// number, so the terminal's theme draws them as it draws the statusline's, and
// a truecolor value as itself.
function tmuxColor(spec: ColorSpec | undefined): string {
  if (spec === undefined || spec.isDefault) return "terminal";
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

// rich-js's text attributes: every on/off field of a `Style`.
type StyleAttribute = {
  [K in keyof StyleOptions]-?: NonNullable<StyleOptions[K]> extends boolean
    ? K
    : never;
}[keyof StyleOptions];

// Every text attribute a rich-js `Style` carries, and tmux's name for it; null
// where tmux has none, which the lane refuses rather than drawing it some
// other way.
// [LAW:one-source-of-truth] Keyed by rich-js's `StyleOptions`, as the band's
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
} as const satisfies Record<StyleAttribute, string | null>;

const ATTRIBUTE_NAMES = Object.keys(ATTRIBUTES) as Array<
  keyof typeof ATTRIBUTES
>;

// tmux reads `#` as the start of a directive in what it draws, and `##` as a
// `#` (measured, tmux 3.6a: a user option's value is not expanded again as a
// format, but its `#[…]` directives are drawn).
function escaped(text: string): string {
  return text.replaceAll("#", "##");
}

// A run's whole style, from nothing: `none` clears the attributes the run
// before it set, so each run reads alone.
function directive(style: Style): string {
  const attributes = ATTRIBUTE_NAMES.filter((name) => style[name] === true).map(
    (name) => {
      const tmux = ATTRIBUTES[name];
      if (tmux === null)
        throw new Error(`frames: a tmux status line cannot draw ${name} text`);
      return tmux;
    },
  );
  return `#[${["none", `fg=${tmuxColor(style.color)}`, `bg=${tmuxColor(style.bgcolor)}`, ...attributes].join(",")}]`;
}

const PLAIN = new Style();

// One rendered bar, ANSI and OSC 8, as the rows a status line draws. Text no
// span covers is drawn plain; a linked run is a range whose id names its link.
export function tmuxStatusFrame(ansi: string): TmuxStatusBar {
  const links: Record<string, string> = {};
  const run = (text: string, style: Style): string => {
    const drawn = directive(style) + escaped(text);
    if (style.link === undefined) return drawn;
    const range = rangeOf(style.link);
    links[range] = style.link;
    return `#[range=user|${range}]${drawn}#[norange]`;
  };
  const rows = new AnsiDecoder().decode(ansi).map((line) => {
    const plain = line.plain;
    const runs: string[] = [];
    let at = 0;
    for (const span of line.spans) {
      if (!(span.style instanceof Style)) {
        throw new Error(
          `frames: the decoder gave a span a ${typeof span.style} style`,
        );
      }
      if (span.start > at) runs.push(run(plain.slice(at, span.start), PLAIN));
      runs.push(run(plain.slice(span.start, span.end), span.style));
      at = span.end;
    }
    if (at < plain.length) runs.push(run(plain.slice(at), PLAIN));
    return runs.join("");
  });
  return { rows, links };
}

// One pushed render response as the frame the status line draws.
// [LAW:no-silent-failure] A bar the status line cannot draw is a frame saying
// why, in the diagnostics' colours, as the band's is; a render that
// failed is drawn as the statusline draws it, its error glyph.
export function tmuxStatusResponse(resp: Response): TmuxStatusBar {
  const ansi = planOutcome(renderOutcomeOf(resp)).output;
  try {
    return tmuxStatusFrame(ansi);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return tmuxStatusFrame(
      ansiOf(diagnosticFrame(`⚠ cc-candybar ${why}`, DIAGNOSTIC_ERROR_COLORS)),
    );
  }
}
