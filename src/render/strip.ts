import {
  Strip,
  RichText,
  Style,
  CellJoiner,
  JOINERS,
  FlexStrip,
  Segment,
  render,
  resolveDestination,
  type Joiner,
  type SeamForm,
  type Renderable,
  type ColorSystemName,
} from "@promptctl/rich-js";
import type { ColorCompatibility, Endcaps } from "../themes/policy.js";
import { RENDER_THEME } from "./rich-theme.js";
import { STILL, type RowMotion } from "./effect.js";
import { encodeAnsi, plainOf, runLines, type Run } from "./frame.js";

// rich-js `renderToString`'s width when it is handed none: what an unbounded
// Strip is drawn at, so a row drawn here is the bytes it always was.
const UNBOUNDED_DRAW_WIDTH = 80;

// The identity rich-js's `HostFrame.host` asks for: what drew a frame, with
// nothing on it to read, so the frame's `time` is the only time in it.
const ROW_HOST = {};

// [LAW:types-are-the-program] A drawn row: its lines of runs, one for a row
// that fit and several for one FlexStrip wrapped, and the moment, in wall
// seconds, at which something on it next changes without new data — a looping
// effect, a transition in flight, the closing flash, a template's `frames` —
// or Infinity when nothing will. Read off what was drawn (rich-js
// `Segment.nextChange`, and the holds the render was told) rather than
// inferred from what the config asked for, so motion a template draws counts
// exactly as an effect does. Every animation on a row is drawn on the host
// clock (`FrameClock`), so its cells, whatever drew them, say one time.
export interface DrawnRow {
  readonly lines: ReadonlyArray<readonly Run[]>;
  readonly nextChange: number;
}

// [LAW:single-enforcer] Every renderable this module serializes is drawn here,
// with `RENDER_THEME` — the theme the cell splitter resolves a fragment's style
// through before the render — so the two agree by construction rather than by
// each call site remembering the option. The segments are drawn once and read
// twice: as lines of runs, and asked when they next change. A row drawn under
// motion is drawn for its frame's `time`, the one moment rich-js hands every
// animation placed in it; a still row is drawn for none.
// [LAW:one-source-of-truth] rich-js's hold of a frame is its cells' holds and
// the holds it was told that no cell carries (`RenderOptions.onHold`), so the
// row's next change is the soonest of both.
function draw(
  renderable: Renderable,
  options: {
    readonly colorSystem: ColorSystemName | null;
    readonly width?: number;
    readonly time?: number;
  },
): DrawnRow {
  const destination = resolveDestination(options.colorSystem);
  const { time } = options;
  let told = Infinity;
  const segments = [
    ...render(renderable, {
      maxWidth: options.width ?? UNBOUNDED_DRAW_WIDTH,
      isTerminal: false,
      asciiOnly: false,
      theme: RENDER_THEME,
      colorSystem: destination.colorSystem,
      ...(time === undefined ? {} : { frame: { time, host: ROW_HOST } }),
      // [LAW:no-silent-failure] rich-js would draw a style it cannot resolve
      // as no style at all; a name the theme lacks is a broken config, so it
      // throws here exactly as the cell splitter throws on it.
      onStyleError: (error) => {
        throw error;
      },
      onHold: ({ nextChange }) => {
        told = Math.min(told, nextChange);
      },
    }),
  ];
  return {
    lines: runLines(segments, destination.colorSystem),
    nextChange: Math.min(Segment.nextChange(segments), told),
  };
}

// [LAW:one-source-of-truth] `Endcaps`/`ColorCompatibility` and their value lists live
// in themes/policy.ts (the render-identifier policy module, importable by the
// option-source machinery without a render→template-engine cycle). Re-exported
// here so render-layer consumers can keep importing them from the strip module.
export type { ColorCompatibility, Endcaps };

// [LAW:one-source-of-truth] Raw terminal cols we assume when the wire
// didn't give us one (older client, env-stripped spawn). RAW — not
// post-reserve — so the Claude-Code-UI reserve applies uniformly across
// wire and fallback paths (callers thread this through
// applyClaudeCodeReserve from src/utils/terminal-width).
export const DEFAULT_TERMINAL_WIDTH = 120;

export interface BuildLineOptions {
  endcaps: Endcaps;
  // [LAW:types-are-the-program] Narrower than rich-js's colour-system names on
  // purpose: the four explicit depths only. "auto"/null never reach a render —
  // the daemon is detached, so env detection would read the wrong terminal;
  // the loader rejects "auto" at the trust boundary (see COLOR_COMPATIBILITIES
  // in themes/policy.ts), and every construction site states a resolved depth.
  colorCompatibility: ColorCompatibility;
  separator?: string;
  // [LAW:types-are-the-program] Every render carries a width. Required (not
  // optional) so callers cannot silently drop the wire's value.
  // [LAW:one-source-of-truth] Width is a FACT (usable cells) feeding two
  // consumers — FlexStrip's wrap limit AND the picker's pagination
  // (`term.cols`). It stays finite even when wrapping is off; `wrap` below is
  // the separate POLICY of whether rows may soft-break at that width.
  width: number;
  // [LAW:types-are-the-program] Required for the same reason as width: the
  // wrap decision (globals.autoWrap, default on) must reach every render
  // explicitly — encoding "no wrap" as width=Infinity would corrupt the
  // picker's pagination, which reads the same width value.
  wrap: boolean;
  // [LAW:one-source-of-truth] Spaces inside each segment cell per side
  // (globals.padding, default 1 — the legacy display.padding, intra-cell,
  // not rich-js FlexStrip's inter-item gap). Required so every construction
  // site states the resolved value; the cell builders derive from it and
  // never re-default.
  padding: number;
}

// Plain drawn with an authored separator (globals.default_separator): the
// bundled plain shape with the separator as its one glyph, drawn as written.
// rich-js builds a joiner's ascii form up front and refuses a non-ASCII glyph
// in it; the bar never draws that form, so plain's own fills the slot.
// Memoised per separator, so a render does not re-parse it.
const separatorJoiners = new Map<string, CellJoiner>();
function plainWith(separator: string): CellJoiner {
  const known = separatorJoiners.get(separator);
  if (known !== undefined) return known;
  const withGlyph = (form: SeamForm): SeamForm => {
    // [LAW:types-are-the-program] A cap standing in the seam's place is drawn
    // as the caps it names; only a join cell carries the authored glyph.
    const seam = form.seam.map((cell) =>
      "cap" in cell ? cell : { ...cell, glyph: separator },
    );
    return { seam };
  };
  const { seam, caps } = JOINERS.plain;
  const joiner = new CellJoiner(
    {
      glyph: withGlyph(seam.glyph),
      ascii: seam.ascii,
    },
    caps,
  );
  separatorJoiners.set(separator, joiner);
  return joiner;
}

// [LAW:dataflow-not-control-flow] The joiner is a lookup: rich-js's `JOINERS`
// holds every one by the name `Endcaps` admits, so there is no arm per shape
// to keep in step with the list. Plain alone reads the authored separator,
// which is user data.
function pickJoiner(endcaps: Endcaps, separator?: string): Joiner {
  return endcaps === "plain" && separator !== undefined
    ? plainWith(separator)
    : JOINERS[endcaps];
}

type StripShape = Pick<BuildLineOptions, "endcaps" | "separator">;

// [LAW:single-enforcer] Strip geometry has one owner — this module builds every
// joiner (pickJoiner), so it alone measures what a styled row costs beyond its
// content. Both costs below are MEASURED through the joiner that will draw the
// row rather than declared: a declared table restates rich-js's glyphs (and, for
// plain, its private default separator) and has to be re-synced by hand every
// time a joiner changes. Memoised per joiner shape: a render asks once per shape.
const geometryMemo = new Map<string, { chrome: number; seam: number }>();
function stripGeometry(options: StripShape): { chrome: number; seam: number } {
  const key = JSON.stringify([options.endcaps, options.separator ?? null]);
  const known = geometryMemo.get(key);
  if (known !== undefined) return known;
  const joiner = pickJoiner(options.endcaps, options.separator);
  const cell = (bgcolor: string): RichText =>
    new RichText("x", {
      end: "",
      overflow: "ignore",
      style: new Style({ bgcolor }),
    });
  const width = (cells: RichText[]): number => {
    const { lines } = draw(new Strip(cells, joiner), { colorSystem: null });
    return new RichText(plainOf(lines.flat())).cellLength;
  };
  const one = width([cell("#101010")]);
  const geometry = {
    chrome: one - 1,
    seam: width([cell("#101010"), cell("#202020")]) - one - 1,
  };
  geometryMemo.set(key, geometry);
  return geometry;
}

// The columns a row costs beyond its content however many cells it holds: the
// joiner's caps (powerline's lead and tail, capsule's two caps, nothing for
// plain). FlexStrip counts them INSIDE the width it wraps to, so a single
// full-width row's content can occupy only `width - chrome` — a width-fit widget
// (the picker) reserves it so a packed row never wraps.
export function stripChromeCols(options: StripShape): number {
  return stripGeometry(options).chrome;
}

// What one MORE cell costs a row beyond its own content: the seam the joiner
// lays between it and its neighbour (powerline's arrow, capsule's facing caps
// and the gap between them, plain's separator text).
export function stripSeamCols(options: StripShape): number {
  return stripGeometry(options).seam;
}

// Unicode's three Private Use Areas: the code points no standard font draws,
// where Powerline and Nerd Fonts put their glyphs.
const PRIVATE_USE =
  /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

// The private-use glyphs in a text, each once, in the order written.
export function privateGlyphsIn(text: string): string {
  return [...new Set(text.match(PRIVATE_USE) ?? [])].join("");
}

// The private-use glyphs a row draws — its caps and the seam between two
// cells, each once, in the order drawn: what a terminal needs a Nerd Font (or
// its own built-in glyphs) to show. MEASURED through the joiner that draws the
// row, as its geometry is, so a joiner rich-js adds needs no entry here. Two
// cells reach every part a join draws, because a seam is one form whatever
// the two grounds are.
export function stripPrivateGlyphs(options: StripShape): string {
  const joiner = pickJoiner(options.endcaps, options.separator);
  const cell = (bgcolor: string): RichText =>
    new RichText("x", { end: "", style: new Style({ bgcolor }) });
  const cells = [cell("#101010"), cell("#202020")];
  const { lines } = draw(new Strip(cells, joiner), { colorSystem: null });
  return privateGlyphsIn(plainOf(lines.flat()));
}

// [LAW:single-enforcer] The width a line breaks at, the one reading of the
// `wrap` policy over the `width` fact: unbounded where a row may not break.
export function lineWidth(
  options: Pick<BuildLineOptions, "wrap" | "width">,
): number {
  return options.wrap ? options.width : Infinity;
}

// [LAW:one-source-of-truth] rich-js's own word wrap of one cell, as the text of
// its lines: a folding copy drawn through the one `draw`. rich-js keeps its line
// breaker private, and this is what spares the project a second theory of where
// a line may break.
export function wrappedLines(text: RichText, width: number): readonly string[] {
  const wrapping = text.copy();
  wrapping.overflow = "fold";
  return draw(wrapping, { colorSystem: null, width }).lines.map(plainOf);
}

/**
 * [LAW:single-enforcer] The one place RichText cells become lines of runs.
 * Every render path (DSL RichText[] via the template-engine pipeline, debug
 * per-segment serialization) flows through here. The wrap dispatch lives here too:
 * wrap enabled at a finite width → FlexStrip (rich-js owns the wrap
 * algebra); otherwise → Strip, one unbounded line.
 *
 * [LAW:dataflow-not-control-flow] The dispatch is on values, not on caller
 * branches: `wrap` (the globals.autoWrap policy) gates whether the finite
 * width acts as a break limit. An infinite width has nothing to break at,
 * so it renders unbounded regardless of `wrap`.
 *
 * A row of no cells draws nothing and is still a row: one line of no runs.
 */
export function drawStripCells(
  cells: readonly RichText[],
  options: BuildLineOptions,
  motion: RowMotion = STILL,
): DrawnRow {
  if (cells.length === 0) return { lines: [[]], nextChange: Infinity };
  const joiner = pickJoiner(options.endcaps, options.separator);
  const flex = Number.isFinite(lineWidth(options));
  const drawn = {
    colorSystem: options.colorCompatibility,
    ...(flex ? { width: options.width } : {}),
  };
  const strip = flex
    ? new FlexStrip([...cells], { joiner })
    : new Strip([...cells], joiner);
  // [LAW:single-enforcer] An effect wraps the whole composed strip, here, so a
  // powerline seam's ink — its left cell's fill — moves with that cell. The
  // effect reads the row's width off the frame it draws.
  const row =
    motion.kind === "still"
      ? draw(strip, drawn)
      : draw(motion.wrap(strip), { ...drawn, time: motion.time });
  // [LAW:single-enforcer] Strip and FlexStrip each end their own last line (a
  // block renderable's contract in rich-js), which `runLines` reads as that
  // line's end, so a row is its lines' content and no more. A strip that drew
  // no line broke that contract, and would drop its row from the frame.
  if (row.lines.length === 0) {
    throw new Error("drawStripCells: rich-js strip drew no line");
  }
  return row;
}

// A row's bytes alone, for a caller that draws no motion.
export function renderStripCells(
  cells: readonly RichText[],
  options: BuildLineOptions,
): string {
  return encodeAnsi(
    drawStripCells(cells, options).lines,
    options.colorCompatibility,
  );
}
