import { Theme, type Style, type TextStyle } from "@promptctl/rich-js";

/**
 * The rich-js `Theme` every cc-candybar render draws with: what a style NAME on
 * a RichText stands for. rich-js keeps a string style unresolved (a
 * `LayeredStyle` when a style function wraps it) until a render resolves it
 * through its theme, so code that reads a fragment's style before the render
 * must resolve it through this same theme.
 *
 * [LAW:one-source-of-truth] Drawn with by strip.ts's one `draw` and read by the
 * cell splitter, so the two cannot disagree about what a name means.
 */
export const RENDER_THEME = new Theme({
  // A joiner draws `plain`'s separator and `metro`'s rail on the terminal's own
  // ground, which the detached daemon cannot see; rich-js's `bright_black` is a
  // slot some terminal themes paint as that ground. The terminal's own text on
  // its own ground is the one pair known to read there.
  "strip.separator": "default",
  "strip.rail": "default",
});

/**
 * The `Style` a RichText's stored style stands for under `RENDER_THEME`: a
 * definition parses, a theme name reads the theme, and a `LayeredStyle` is its
 * name resolved with its addition on top. A name the theme lacks throws here,
 * as it does in `draw`. The render still sanitizes a resolved link of OSC
 * terminators, which this does not.
 */
export function resolvedStyle(style: TextStyle): Style {
  return RENDER_THEME.resolve(style);
}
