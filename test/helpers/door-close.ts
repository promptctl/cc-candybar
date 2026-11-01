import { decodeAnsi, type ColorRgba } from "@promptctl/rich-js";
import { DOOR_CLOSE_GLYPH } from "../../src/config/disclosure";
import { resolvedStyle } from "../../src/render/rich-theme";

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
 * The one ✖ in `rendered`: its ink and its ground, each as the terminal shows
 * the colour the frame writes for it (at 256 colours the cube or grey entry,
 * at ansi the sixteen rich-js assumes), read through rich-js's `decodeAnsi`.
 */
export function doorClose(rendered: string): { readonly ink: ColorRgba; readonly ground: ColorRgba } {
  const found = rendered.split("\n").flatMap((line) => {
    const text = decodeAnsi(line);
    const at = text.plain.indexOf(DOOR_CLOSE_GLYPH);
    const span = text.spans.find(({ start, end }) => start <= at && at < end);
    if (span === undefined) return [];
    const { color, bgcolor } = resolvedStyle(span.style);
    // [LAW:no-silent-failure] An unset colour would be measured as the
    // terminal's own, which no theme names.
    if (color === undefined || bgcolor === undefined) {
      throw new Error(`the door's ✖ is drawn without its own ${color === undefined ? "ink" : "ground"}`);
    }
    return [{ ink: color.getTruecolor(), ground: bgcolor.getTruecolor() }];
  });
  if (found.length !== 1) throw new Error(`expected one ${DOOR_CLOSE_GLYPH} in the frame, found ${found.length}`);
  return found[0]!;
}
