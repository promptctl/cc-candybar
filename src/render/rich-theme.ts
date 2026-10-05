import { Theme } from "@promptctl/rich-js";

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
export const RENDER_THEME = new Theme();
