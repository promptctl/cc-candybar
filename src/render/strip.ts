import {
  Strip,
  RichText,
  Style,
  PowerlineJoiner,
  POWERLINE_JOINER_GLYPHS,
  CapsuleJoiner,
  PlainJoiner,
  FlexStrip,
  renderToString,
  type Joiner,
  type Renderable,
  type RenderToStringOptions,
  type PowerlineJoinerOptions,
  type CapsuleJoinerOptions,
} from "@promptctl/rich-js";
import type { Charset, ColorCompatibility, Endcaps } from "../themes/policy.js";
import { RENDER_THEME } from "./rich-theme.js";

// [LAW:single-enforcer] Every renderable this module serializes is drawn here,
// with `RENDER_THEME` — the theme the cell splitter resolves a fragment's style
// through before the render — so the two agree by construction rather than by
// each call site remembering the option.
function draw(
  renderable: Renderable,
  options: Omit<RenderToStringOptions, "theme">,
): string {
  return renderToString(renderable, { ...options, theme: RENDER_THEME });
}

export interface RenderedSegmentLike {
  type: string;
  text: string;
  bgHex?: string;
  fgHex?: string;
}

// [LAW:one-source-of-truth] `Endcaps`/`Charset` and their value lists live
// in themes/policy.ts (the render-identifier policy module, importable by the
// option-source machinery without a render→template-engine cycle). Re-exported
// here so render-layer consumers can keep importing them from the strip module.
export type { Charset, ColorCompatibility, Endcaps };

// [LAW:one-source-of-truth] Raw terminal cols we assume when the wire
// didn't give us one (older client, env-stripped spawn). RAW — not
// post-reserve — so the Claude-Code-UI reserve applies uniformly across
// wire and fallback paths (callers thread this through
// applyClaudeCodeReserve from src/utils/terminal-width).
export const DEFAULT_TERMINAL_WIDTH = 120;

// [LAW:one-source-of-truth] The display globals' defaults live in
// themes/policy.ts beside their resolvers (and padding's range), because the
// config loader needs them too and config must not import render
// [LAW:one-way-deps]. Re-exported here on the same terms as the types above, so
// render-layer consumers keep importing them from the strip module.
export {
  DEFAULT_WRAP,
  DEFAULT_PADDING,
  DEFAULT_CHARSET,
  DEFAULT_COLOR_COMPATIBILITY,
} from "../themes/policy.js";

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
  // [LAW:one-source-of-truth] Which glyph vocabulary the joiners render with
  // (globals.charset, default "unicode" — the legacy display.charset).
  // Required for the same reason as padding: the resolved value reaches every
  // render explicitly; pickJoiner derives from it and never re-defaults.
  charset: Charset;
}

// [LAW:dataflow-not-control-flow] Charset variability lives in these VALUES,
// not in branches: per endcaps shape, each charset names the joiner-construction
// options. The unicode entries are rich-js's own — it owns the canonical
// powerline glyphs (U+E0B0 / U+E0B1 / U+E0D7 / U+E0B6+U+E0B4), and restating them here
// would be a second source that could drift [LAW:one-source-of-truth]. The
// ascii glyphs are single-column, the same display width as the unicode caps;
// the strip's geometry is measured per charset (stripGeometry below), so a
// wider glyph would cost its real width rather than break a declared one.
const POWERLINE_GLYPHS: Record<Charset, PowerlineJoinerOptions> = {
  unicode: POWERLINE_JOINER_GLYPHS,
  // The divider is drawn between neighbours whose backgrounds match, where the
  // arrow would vanish; `|` is its single-column ascii form. `<` leads a row
  // and `>` tails it, so the ascii row has the same shape at both ends.
  ascii: { glyph: ">", divider: "|", lead: "<", tail: ">" },
};
const CAPSULE_GLYPHS: Record<Charset, CapsuleJoinerOptions> = {
  unicode: {},
  ascii: { left: "(", right: ")" },
};

function pickJoiner(
  endcaps: Endcaps,
  charset: Charset,
  separator?: string,
): Joiner {
  // [LAW:dataflow-not-control-flow] joiner choice is data-driven; one arm per
  // shape. Endcaps pick the joiner CLASS, charset indexes the glyph options fed
  // to it — the two dimensions stay orthogonal (any endcaps render under either
  // charset). Plain takes no charset lookup: its separator is already user
  // data (globals.default_separator) and its default (" | ") is ASCII-safe.
  // [LAW:types-are-the-program] Total over Endcaps — the `never`
  // default makes adding an ENDCAPS_SHAPES member a compile error here until it
  // gets a joiner, so the picker's domain can never offer an unrenderable shape.
  switch (endcaps) {
    case "capsule":
      return new CapsuleJoiner(CAPSULE_GLYPHS[charset]);
    case "plain":
      return new PlainJoiner(separator !== undefined ? { separator } : {});
    case "powerline":
      return new PowerlineJoiner(POWERLINE_GLYPHS[charset]);
    default: {
      const _exhaustive: never = endcaps;
      return _exhaustive;
    }
  }
}

type StripShape = Pick<BuildLineOptions, "endcaps" | "charset" | "separator">;

// [LAW:single-enforcer] Strip geometry has one owner — this module builds every
// joiner (pickJoiner), so it alone measures what a styled row costs beyond its
// content. Both costs below are MEASURED through the joiner that will draw the
// row rather than declared: a declared table restates rich-js's glyphs (and, for
// plain, its private default separator) and has to be re-synced by hand every
// time a joiner changes. Memoised per joiner shape: a render asks once per shape.
const geometryMemo = new Map<string, { chrome: number; seam: number }>();
function stripGeometry(options: StripShape): { chrome: number; seam: number } {
  const key = JSON.stringify([
    options.endcaps,
    options.charset,
    options.separator ?? null,
  ]);
  const known = geometryMemo.get(key);
  if (known !== undefined) return known;
  const joiner = pickJoiner(
    options.endcaps,
    options.charset,
    options.separator,
  );
  const cell = (bgcolor: string): RichText =>
    new RichText("x", {
      end: "",
      overflow: "ignore",
      style: new Style({ bgcolor }),
    });
  const width = (cells: RichText[]): number =>
    new RichText(
      draw(new Strip(cells, joiner), { colorSystem: null }).replace(/\n$/, ""),
    ).cellLength;
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

function toCell(seg: RenderedSegmentLike, padding: number): RichText {
  // [LAW:one-source-of-truth] Intra-cell padding derives from the one resolved
  // globals.padding value on BuildLineOptions — the joiners sit between cells;
  // padding sits inside, inheriting the cell's wrapping style (bg fill).
  const style = new Style({
    bgcolor: seg.bgHex || undefined,
    color: seg.fgHex || undefined,
  });
  return new RichText(seg.text, { style, end: "", overflow: "ignore" }).pad(
    padding,
  );
}

/**
 * [LAW:single-enforcer] The one place RichText cells become an ANSI byte
 * string. Every render path (DSL RichText[] via the template-engine
 * pipeline, buildLineStrip's input-shape adapter, debug per-segment
 * serialization) flows through here. The wrap dispatch lives here too:
 * wrap enabled at a finite width → FlexStrip (rich-js owns the wrap
 * algebra); otherwise → Strip, one unbounded line.
 *
 * [LAW:dataflow-not-control-flow] The dispatch is on values, not on caller
 * branches: `wrap` (the globals.autoWrap policy) gates whether the finite
 * width acts as a break limit. An infinite width has nothing to break at,
 * so it renders unbounded regardless of `wrap`.
 */
export function renderStripCells(
  cells: readonly RichText[],
  options: BuildLineOptions,
): string {
  if (cells.length === 0) return "";
  const joiner = pickJoiner(
    options.endcaps,
    options.charset,
    options.separator,
  );
  const colorSystem = options.colorCompatibility;
  const out =
    options.wrap && Number.isFinite(options.width)
      ? draw(new FlexStrip([...cells], { joiner }), {
          width: options.width,
          colorSystem,
        })
      : draw(new Strip([...cells], joiner), { colorSystem });
  // [LAW:single-enforcer] Strip and FlexStrip each end their own last line (a
  // block renderable's contract in rich-js); a row here is a line's CONTENT —
  // the caller joins rows with "\n" — so the one terminator comes off here.
  if (!out.endsWith("\n")) {
    throw new Error(
      "renderStripCells: rich-js strip output did not end its last line",
    );
  }
  return out.slice(0, -1);
}

/**
 * Input-shape adapter for callers that hold RenderedSegmentLike[] rather
 * than pre-constructed RichText cells. Wrap behavior is identical to
 * renderStripCells — the cell construction is the only difference.
 */
export function buildLineStrip(
  segments: readonly RenderedSegmentLike[],
  options: BuildLineOptions,
): string {
  return renderStripCells(
    segments.map((seg) => toCell(seg, options.padding)),
    options,
  );
}
