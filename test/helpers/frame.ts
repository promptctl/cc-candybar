// A drawn frame's links as the tests ask about them.
import { linksOf } from "../../src/click/read";
import type { Frame } from "../../src/render/frame";

/** The URL of every link the frame draws, in order. */
export const linkUrls = (frame: Pick<Frame, "rows">): string[] =>
  linksOf(frame).map(({ url }) => url);

/**
 * The URL of every link drawn bold — the renderer's "current selection"
 * marking — once per link, in order. A link whose cells change look is several
 * runs, and the first decides.
 */
export const boldUrls = ({ rows }: Pick<Frame, "rows">): string[] =>
  rows.flatMap(({ runs }) =>
    runs
      .filter(({ text }) => text !== "")
      .flatMap(({ link, attrs }, i, drawn) =>
        link !== undefined &&
        link !== drawn[i - 1]?.link &&
        attrs?.includes("bold") === true
          ? [link]
          : [],
      ),
  );
