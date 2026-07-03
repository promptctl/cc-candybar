import {
  Strip,
  RichText,
  Style,
  PowerlineJoiner,
  CapsuleJoiner,
  PlainJoiner,
  FlexStrip,
  renderToString,
  type Joiner,
  type ColorSystemSpec,
} from "@promptctl/rich-js";
import type { StripStyle } from "../themes/policy.js";

export interface RenderedSegmentLike {
  type: string;
  text: string;
  bgHex?: string;
  fgHex?: string;
}

// [LAW:one-source-of-truth] `StripStyle` and its value list live in
// themes/policy.ts (the style-identifier policy module, importable by the
// option-source machinery without a render→template-engine cycle). Re-exported
// here so render-layer consumers can keep importing it from the strip module.
export type { StripStyle };

// [LAW:one-source-of-truth] Raw terminal cols we assume when the wire
// didn't give us one (older client, env-stripped spawn). RAW — not
// post-reserve — so the Claude-Code-UI reserve applies uniformly across
// wire and fallback paths (callers thread this through
// applyClaudeCodeReserve from src/utils/terminal-width).
export const DEFAULT_TERMINAL_WIDTH = 120;

// [LAW:one-source-of-truth] The one statement of the globals.autoWrap
// default (on — current behavior). Every resolver of the config global
// (`globals.autoWrap ?? DEFAULT_WRAP`) derives from this constant.
export const DEFAULT_WRAP = true;

// [LAW:one-source-of-truth] The one statement of the globals.padding
// default (one space per side inside each segment cell — current behavior,
// matching the legacy display.padding). Every resolver of the config global
// (`globals.padding ?? DEFAULT_PADDING`) derives from this constant.
export const DEFAULT_PADDING = 1;

export interface BuildLineOptions {
  style: StripStyle;
  colorCompatibility: ColorSystemSpec;
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

function pickJoiner(style: StripStyle, separator?: string): Joiner {
  // [LAW:dataflow-not-control-flow] joiner choice is data-driven; one arm per
  // shape. [LAW:types-are-the-program] Total over StripStyle — the `never`
  // default makes adding a STRIP_STYLES member a compile error here until it
  // gets a joiner, so the picker's domain can never offer an unrenderable shape.
  switch (style) {
    case "capsule":
      return new CapsuleJoiner();
    case "plain":
      return new PlainJoiner(separator !== undefined ? { separator } : {});
    case "powerline":
      return new PowerlineJoiner();
    default: {
      const _exhaustive: never = style;
      return _exhaustive;
    }
  }
}

// [LAW:single-enforcer] Strip geometry has one owner — this module builds every
// joiner (pickJoiner) and so alone knows the structural chrome a styled row costs
// beyond its content: the joiner's end-caps, which FlexStrip paints OUTSIDE the
// width budget. A single full-width row's content can occupy only `width - chrome`
// before the caps push the line past `width`. Returned per style so a width-fit
// widget (the picker) can reserve it and never overflow the wrapped line.
//
// [LAW:dataflow-not-control-flow] / [LAW:types-are-the-program] Total over
// StripStyle — the `never` default makes adding a STRIP_STYLES member a compile
// error here until its chrome is declared, the same guard pickJoiner carries. The
// numbers are the default cap glyphs pickJoiner constructs: powerline appends ONE
// trailing separator (U+E0B0, 1 col); capsule brackets BOTH edges (U+E0B6 +
// U+E0B4, 2 cols); plain has no caps. test/picker-pagination.test.ts measures the
// real rendered chrome against these so the declaration cannot drift from rich-js.
export function stripChromeCols(style: StripStyle): number {
  switch (style) {
    case "powerline":
      return 1;
    case "capsule":
      return 2;
    case "plain":
      return 0;
    default: {
      const _exhaustive: never = style;
      return _exhaustive;
    }
  }
}

function toCell(seg: RenderedSegmentLike, padding: number): RichText {
  // [LAW:one-source-of-truth] Intra-cell padding derives from the one resolved
  // globals.padding value on BuildLineOptions — the joiners sit between cells;
  // padding sits inside, inheriting the cell's wrapping style (bg fill).
  const style = new Style({
    bgcolor: seg.bgHex || undefined,
    color: seg.fgHex || undefined,
  });
  return new RichText(seg.text, { style, end: "", noWrap: true }).pad(padding);
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
  const joiner = pickJoiner(options.style, options.separator);
  if (options.wrap && Number.isFinite(options.width)) {
    const flex = new FlexStrip([...cells], { joiner });
    const out = renderToString(flex, {
      width: options.width,
      colorSystem: options.colorCompatibility,
    });
    return out.endsWith("\n") ? out.slice(0, -1) : out;
  }
  const strip = new Strip([...cells], joiner);
  return renderToString(strip, {
    colorSystem: options.colorCompatibility,
  });
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
