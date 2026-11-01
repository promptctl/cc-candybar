import type { ColorRgba } from "@promptctl/rich-js";
import { DOOR_CLOSE_GLYPH } from "../../src/config/disclosure";
import type { Frame } from "../../src/render/frame";
import { truecolorOf } from "./frame";

// The settings door's open ✖ as a frame draws it, and the reds a theme names
// for its error role: what the door's tests read the ✖ by and hold it to,
// spelled here once and apart from the code under test.

/** Every red a theme names for its error role: its text-red, and the role's ladder, base included. */
export const ERROR_REDS = [
  "text-error",
  "error-darken-3",
  "error-darken-2",
  "error-darken-1",
  "error",
  "error-lighten-1",
  "error-lighten-2",
  "error-lighten-3",
] as const;
export type ErrorRed = (typeof ERROR_REDS)[number];

/**
 * The one ✖ in a frame: its ink and its ground, each as the terminal shows the
 * colour drawn for it (at 256 colours the cube or grey entry, at ansi the
 * sixteen rich-js assumes).
 */
export function doorClose({ rows }: Pick<Frame, "rows">): { readonly ink: ColorRgba; readonly ground: ColorRgba } {
  const found = rows.flatMap(({ runs }) => runs.filter(({ text }) => text.includes(DOOR_CLOSE_GLYPH)));
  if (found.length !== 1) throw new Error(`expected one ${DOOR_CLOSE_GLYPH} in the frame, found ${found.length}`);
  const { fg, bg } = found[0]!;
  return { ink: truecolorOf(fg), ground: truecolorOf(bg) };
}
