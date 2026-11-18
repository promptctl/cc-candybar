import type { ColorRgba } from "@promptctl/rich-js";
import { DOOR_CLOSE_GLYPH } from "../../src/config/disclosure";
import type { Frame } from "../../src/render/frame";
import { truecolorOf } from "./frame";

// The settings door's open ✖ as a frame draws it, which the door's tests
// read it by.

/**
 * The one ✖ in a frame: its ink and its ground, each as the terminal shows the
 * colour drawn for it (at 256 colours the cube or grey entry, at ansi the
 * sixteen rich-js assumes).
 */
export function doorClose({ rows }: Pick<Frame, "rows">): {
  readonly ink: ColorRgba;
  readonly ground: ColorRgba;
} {
  const found = rows.flatMap(({ runs }) =>
    runs.filter(({ text }) => text.includes(DOOR_CLOSE_GLYPH)),
  );
  if (found.length !== 1)
    throw new Error(
      `expected one ${DOOR_CLOSE_GLYPH} in the frame, found ${found.length}`,
    );
  const { fg, bg } = found[0]!;
  return { ink: truecolorOf(fg), ground: truecolorOf(bg) };
}
