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
  type PowerlineJoinerOptions,
  type CapsuleJoinerOptions,
} from "@promptctl/rich-js";
import type {
  Charset,
  ColorCompatibility,
  StripStyle,
} from "../themes/policy.js";

export interface RenderedSegmentLike {
  type: string;
  text: string;
  bgHex?: string;
  fgHex?: string;
}

export type { Charset, ColorCompatibility, StripStyle };

// RAW terminal cols assumed when the wire gives none — not post-reserve, so the Claude-Code-UI reserve applies uniformly.
export const DEFAULT_TERMINAL_WIDTH = 120;

// [LAW:one-way-deps] These defaults live in themes/policy.ts because the config loader needs them and config must not import render.
export { DEFAULT_WRAP, DEFAULT_PADDING } from "../themes/policy.js";

export const DEFAULT_CHARSET: Charset = "unicode";

// [LAW:one-source-of-truth] The one statement of this default — deliberately not "auto".
export const DEFAULT_COLOR_COMPATIBILITY: ColorCompatibility = "truecolor";

export interface BuildLineOptions {
  style: StripStyle;
  // [LAW:types-are-the-program] The four explicit depths only: the daemon is detached, so "auto" would detect the wrong terminal.
  colorCompatibility: ColorCompatibility;
  separator?: string;
  // [LAW:one-source-of-truth] Width is a FACT (usable cells) feeding both FlexStrip's
  // wrap limit and the picker's pagination; it stays finite even when wrapping is off.
  width: number;
  // [LAW:types-are-the-program] Required: encoding "no wrap" as width=Infinity would corrupt the picker's pagination.
  wrap: boolean;
  // [LAW:one-source-of-truth] Spaces INSIDE each cell per side, not FlexStrip's inter-item gap.
  padding: number;
  charset: Charset;
}

// [LAW:dataflow-not-control-flow] Charset variability lives in these VALUES. Unicode is
// empty because rich-js owns its glyphs [LAW:one-source-of-truth]; the ascii ones are
// DELIBERATELY single-column so stripChromeCols stays charset-invariant.
const POWERLINE_GLYPHS: Record<Charset, PowerlineJoinerOptions> = {
  unicode: {},
  ascii: { glyph: ">" },
};
const CAPSULE_GLYPHS: Record<Charset, CapsuleJoinerOptions> = {
  unicode: {},
  ascii: { left: "(", right: ")" },
};

function pickJoiner(
  style: StripStyle,
  charset: Charset,
  separator?: string,
): Joiner {
  // [LAW:dataflow-not-control-flow] Style picks the joiner CLASS, charset indexes its glyph options — orthogonal by construction.
  switch (style) {
    case "capsule":
      return new CapsuleJoiner(CAPSULE_GLYPHS[charset]);
    case "plain":
      return new PlainJoiner(separator !== undefined ? { separator } : {});
    case "powerline":
      return new PowerlineJoiner(POWERLINE_GLYPHS[charset]);
    default: {
      const _exhaustive: never = style;
      return _exhaustive;
    }
  }
}

// [LAW:single-enforcer] This module builds every joiner, so it alone knows the chrome a
// styled row costs beyond its content: end-caps FlexStrip paints OUTSIDE the width budget.
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
  const style = new Style({
    bgcolor: seg.bgHex || undefined,
    color: seg.fgHex || undefined,
  });
  return new RichText(seg.text, { style, end: "", noWrap: true }).pad(padding);
}

/**
 * [LAW:single-enforcer] The one place RichText cells become an ANSI byte string.
 * [LAW:dataflow-not-control-flow] `wrap` gates whether a finite width acts as a break limit.
 */
export function renderStripCells(
  cells: readonly RichText[],
  options: BuildLineOptions,
): string {
  if (cells.length === 0) return "";
  const joiner = pickJoiner(options.style, options.charset, options.separator);
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

export function buildLineStrip(
  segments: readonly RenderedSegmentLike[],
  options: BuildLineOptions,
): string {
  return renderStripCells(
    segments.map((seg) => toCell(seg, options.padding)),
    options,
  );
}
