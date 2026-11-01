// A drawn frame read cell by cell, as the terminal shows it: every visible
// character with its ink and ground at the frame's depth, and every seam the
// joiner drew between two cells.
//
// [LAW:one-source-of-truth] The one reader of a seam. The closing sweep, the
// 256-colour and ansi checks and the nightly theme-identity audit all read a
// join through here, so "the cell an arrow leaves" means one thing in all of
// them: the ground of the column drawn just before it on its line, spaces
// included, read through reverse video.

import { ColorSpec } from "@promptctl/rich-js";
import type { Frame } from "../../src/render/frame";
import { POWERLINE } from "./powerline";

export type Rgb = readonly [number, number, number];
/** A colour as drawn: an RGB triple, or at ansi one of the terminal's sixteen slots. */
export type Drawn = Rgb | { readonly ansi: number };

// A run's colour as this reader holds it. The first sixteen are the terminal
// theme's own slots, so they have no RGB, and `default` is the terminal's own
// colour.
const drawnOf = (color: string | undefined): Drawn | undefined => {
  if (color === undefined || color === "default") return undefined;
  const spec = ColorSpec.parse(color);
  if (spec.number !== undefined && spec.number < 16) return { ansi: spec.number };
  const { hex } = spec.getTruecolor();
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb;
};

// The joiner's glyphs, read off the shape rich-js renders with: the arrow
// between two cells, the lead entering a run (in reverse video, a notch of the
// terminal's ground) and the tail leaving one. U+E0B1 is the thin divider: no
// joiner draws it, so any on a row is a failure.
const { glyph, lead, tail } = POWERLINE;
export const ARROWS: ReadonlySet<string> = new Set([glyph, lead, tail]);
export const DIVIDER = "\u{E0B1}";
const JOINERS = new Set([...ARROWS, "\uE0B4", "\uE0B6"]);

export interface Char {
  readonly ch: string;
  readonly fg?: Drawn;
  readonly bg?: Drawn;
  /** A joiner's glyph: its fg is a neighbour's bg, a shape to keep seamless, not text to keep legible. */
  readonly joiner: boolean;
  /** Drawn in reverse video: a cap's notch, its ink the terminal's ground. */
  readonly reverse: boolean;
  /** The ground of the column drawn just before it on its line, spaces included: for an arrow, the cell it leaves. */
  readonly before?: Drawn;
}

/** Every non-space character of a frame with the fg and bg it is drawn in. */
export function drawnChars({ rows }: Pick<Frame, "rows">): Char[] {
  return rows.flatMap(({ runs }) => {
    let before: Drawn | undefined;
    return runs.flatMap((run) => {
      const fg = drawnOf(run.fg);
      const bg = drawnOf(run.bg);
      const reverse = run.attrs?.includes("reverse") === true;
      return [...run.text].flatMap((ch) => {
        const char: Char = { ch, fg, bg, joiner: JOINERS.has(ch), reverse, before };
        before = reverse ? fg : bg;
        return ch.trim() === "" ? [] : [char];
      });
    });
  });
}

export const isRgb = (c: Drawn | undefined): c is Rgb => Array.isArray(c);
/** Whether two colours are drawn alike: one RGB, or one slot. */
export const same = (a: Drawn | undefined, b: Drawn | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);
export const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * A drawn colour as the terminal shows it, by hex: a slot in the VGA colours
 * rich-js assumes, as its `drawnColour` shows one, so a colour read off a
 * frame compares with one the policy names at any depth. `undefined` is the
 * terminal's own colour.
 */
export const shown = (c: Drawn | undefined): string | undefined =>
  c === undefined ? undefined : isRgb(c) ? hex(c) : ColorSpec.fromAnsi(c.ansi).getTruecolor().hex;

/**
 * An arrow the joiner drew leaving a cell: the ground it leaves, the ground it
 * enters (none for a tail, which enters the terminal's own), and its ink, each
 * as drawn. A lead is a notch drawn in reverse video and leaves no cell, so it
 * is no seam.
 */
export interface Seam {
  readonly glyph: string;
  readonly left: Drawn;
  readonly right: Drawn | undefined;
  readonly ink: Drawn | undefined;
  /** Its index in the characters it was read from, so the same seam of the frame at another depth is found by place. */
  readonly at: number;
}

/** Every arrow in `chars` that leaves a cell, in drawing order. */
export function seams(chars: readonly Char[]): Seam[] {
  return chars.flatMap(({ ch, fg, bg, reverse, before }, at) =>
    ARROWS.has(ch) && !reverse && before !== undefined ? [{ glyph: ch, left: before, right: bg, ink: fg, at }] : [],
  );
}

/**
 * The visible text of the cell the seam at `at` leaves and of the one it
 * enters: the characters back to the joiner before it, and on to the joiner
 * after it.
 */
export const cellBefore = (chars: readonly Char[], at: number): string => {
  let from = at;
  while (from > 0 && !chars[from - 1]!.joiner) from--;
  return chars.slice(from, at).map((c) => c.ch).join("");
};
export const cellAfter = (chars: readonly Char[], at: number): string => {
  let to = at + 1;
  while (to < chars.length && !chars[to]!.joiner) to++;
  return chars.slice(at + 1, to).map((c) => c.ch).join("");
};

/** A cell's text as a seam names it: without its padding or any space. */
export const visible = (text: string): string => text.replace(/\s/g, "");
