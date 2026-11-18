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

// The runs of `rows` drawing a ✖, and how many ✖ they draw between them.
function closeRuns({ rows }: Pick<Frame, "rows">) {
  const runs = rows.flatMap((row) =>
    row.runs.filter(({ text }) => text.includes(DOOR_CLOSE_GLYPH)),
  );
  const glyphs = runs.reduce(
    (n, { text }) => n + text.split(DOOR_CLOSE_GLYPH).length - 1,
    0,
  );
  return { runs, glyphs };
}

/**
 * The one ✖ in a frame: its ink and its ground, each as the terminal shows the
 * colour drawn for it (at 256 colours the cube or grey entry, at ansi the
 * sixteen rich-js assumes).
 */
export function doorClose(frame: Pick<Frame, "rows">): {
  readonly ink: ColorRgba;
  readonly ground: ColorRgba;
} {
  const { runs, glyphs } = closeRuns(frame);
  if (glyphs !== 1)
    throw new Error(
      `expected one ${DOOR_CLOSE_GLYPH} in the frame, found ${glyphs}`,
    );
  const { fg, bg } = runs[0]!;
  return { ink: truecolorOf(fg), ground: truecolorOf(bg) };
}

/**
 * `frame` with the door's ✖ taken out of the run that draws it, so a check
 * that holds every other character to its truecolor floor leaves the ✖ to the
 * door's own tests: its hue outranks its contrast. A frame with the door
 * closed has none and comes back as it is; one holding a second ✖ (edit
 * mode's remove) is refused rather than guessed at.
 */
export function withoutDoorClose(frame: Frame): Frame {
  // [LAW:no-silent-failure] A second ✖ would be exempted with the door's.
  const { glyphs } = closeRuns(frame);
  if (glyphs > 1)
    throw new Error(
      `expected at most one ${DOOR_CLOSE_GLYPH} in the frame, found ${glyphs}`,
    );
  return {
    ...frame,
    rows: frame.rows.map((row) => ({
      ...row,
      runs: row.runs.map((run) => ({
        ...run,
        text: run.text.replace(DOOR_CLOSE_GLYPH, ""),
      })),
    })),
  };
}
