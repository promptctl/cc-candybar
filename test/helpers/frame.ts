// A drawn frame as the tests ask about it: its links, its colours, the run
// under its text, and whether two draws match.
import { isDeepStrictEqual } from "node:util";
import { ColorSpec, type ColorRgba } from "@promptctl/rich-js";
import { linksOf } from "../../src/click/read";
import { plainOf, type Frame, type Run } from "../../src/render/frame";

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

/** The run that draws the character at `at` of a line. */
export const runAt = (runs: readonly Run[], at: number): Run | undefined => {
  let end = 0;
  return runs.find(({ text }) => (end += text.length) > at);
};

/** The run under the first character of `text`, on the first row that draws it. */
export const runUnder = ({ rows }: Pick<Frame, "rows">, text: string): Run | undefined => {
  const { runs } = rows.find(({ runs }) => plainOf(runs).includes(text)) ?? { runs: [] };
  return runAt(runs, plainOf(runs).indexOf(text));
};

/** Whether two frames draw alike. Each carries its own moment, so their rows decide. */
export const sameDraw = (a: Pick<Frame, "rows">, b: Pick<Frame, "rows">): boolean =>
  isDeepStrictEqual(a.rows, b.rows);

/** Every background a frame draws, one per run, in order. */
export const backgroundsOf = ({ rows }: Pick<Frame, "rows">): (string | undefined)[] =>
  rows.flatMap(({ runs }) => runs.map(({ bg }) => bg));

/**
 * A run's colour as the terminal shows it: at 256 colours the cube or grey
 * entry, at ansi the sixteen rich-js assumes.
 * [LAW:no-silent-failure] An unset colour and `default` are the terminal's own,
 * which no theme names, and rich-js would read `default` as white.
 */
export const truecolorOf = (color: string | undefined): ColorRgba => {
  if (color === undefined || color === "default") {
    throw new Error(`a colour the terminal owns has no RGB to measure, got ${color}`);
  }
  return ColorSpec.parse(color).getTruecolor();
};
