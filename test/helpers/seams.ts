// A rendered frame read back as the terminal draws it: every visible
// character with its ink and ground at the frame's depth, and every seam the
// joiner drew between two cells.
//
// [LAW:one-source-of-truth] The one reader of a seam. The closing sweep, the
// 256-colour and ansi checks and the nightly theme-identity audit all decode a
// join through here, so "the cell an arrow leaves" means one thing in all of
// them: the ground of the column drawn just before it on its line, spaces
// included, read through reverse video.

import { ColorSpec } from "@promptctl/rich-js";
import { INVISIBLE } from "./ansi";
import { POWERLINE } from "./powerline";

export type Rgb = readonly [number, number, number];
/** A colour as drawn: an RGB triple, or at ansi one of the terminal's sixteen slots. */
export type Drawn = Rgb | { readonly ansi: number };

// The xterm 256-colour table: the 6×6×6 cube's levels and the grey ramp. The
// first sixteen entries are the terminal theme's own slots, so they have no
// RGB.
const LEVELS = [0, 95, 135, 175, 215, 255];
const xterm = (n: number): Drawn => {
  if (n < 16) return { ansi: n };
  if (n >= 232) {
    const g = 8 + 10 * (n - 232);
    return [g, g, g];
  }
  const i = n - 16;
  return [LEVELS[Math.floor(i / 36)]!, LEVELS[Math.floor(i / 6) % 6]!, LEVELS[i % 6]!];
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

/** Every non-space character of `rendered` with the fg and bg it is drawn in. */
export function drawnChars(rendered: string): Char[] {
  const out: Char[] = [];
  let fg: Drawn | undefined;
  let bg: Drawn | undefined;
  let reverse = false;
  let before: Drawn | undefined;
  let pos = 0;
  const text = (t: string) => {
    for (const ch of t) {
      if (ch === "\n") {
        before = undefined;
        continue;
      }
      if (ch.trim() !== "") out.push({ ch, fg, bg, joiner: JOINERS.has(ch), reverse, before });
      before = reverse ? fg : bg;
    }
  };
  // Every zero-width escape, read by the renderer's own pattern (rich-js's
  // OSC 8 grammar); only SGR carries colour.
  for (const m of rendered.matchAll(INVISIBLE)) {
    text(rendered.slice(pos, m.index));
    pos = m.index + m[0].length;
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(m[0]);
    if (sgr === null) continue;
    const ps = sgr[1]!.split(";").map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (p === 0) [fg, bg, reverse] = [undefined, undefined, false];
      else if (p === 7) reverse = true;
      else if (p === 27) reverse = false;
      else if (p === 39) fg = undefined;
      else if (p === 49) bg = undefined;
      else if ((p === 38 || p === 48) && ps[i + 1] === 2) {
        const c: Rgb = [ps[i + 2]!, ps[i + 3]!, ps[i + 4]!];
        if (p === 38) fg = c;
        else bg = c;
        i += 4;
      } else if ((p === 38 || p === 48) && ps[i + 1] === 5) {
        const c = xterm(ps[i + 2]!);
        if (p === 38) fg = c;
        else bg = c;
        i += 2;
      } else if (p >= 30 && p <= 37) fg = { ansi: p - 30 };
      else if (p >= 90 && p <= 97) fg = { ansi: p - 90 + 8 };
      else if (p >= 40 && p <= 47) bg = { ansi: p - 40 };
      else if (p >= 100 && p <= 107) bg = { ansi: p - 100 + 8 };
    }
  }
  text(rendered.slice(pos));
  return out;
}

export const isRgb = (c: Drawn | undefined): c is Rgb => Array.isArray(c);
/** Whether two colours are drawn alike: one RGB, or one slot. */
export const same = (a: Drawn | undefined, b: Drawn | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);
export const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * A drawn colour as the terminal shows it, by hex: a slot in the VGA colours
 * rich-js assumes, as its `drawnColour` shows one, so a colour read off the
 * bytes compares with one the policy names at any depth. `undefined` is the
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
