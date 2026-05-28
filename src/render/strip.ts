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

export interface RenderedSegmentLike {
  type: string;
  text: string;
  bgHex?: string;
  fgHex?: string;
}

export type StripStyle = "powerline" | "capsule" | "plain";

// [LAW:one-source-of-truth] Fallback when termCols is absent from the wire
// (older client, env-stripped spawn). Matches the implicit default the
// codebase already encoded as MAX_DIAGNOSTIC_LINE_LEN, so byte-equivalence
// holds for the no-width path.
export const DEFAULT_TERMINAL_WIDTH = 120;

export interface BuildLineOptions {
  style: StripStyle;
  colorCompatibility: ColorSystemSpec;
  separator?: string;
  // [LAW:types-are-the-program] Every render carries a width. Finite values
  // wrap via FlexStrip; Number.POSITIVE_INFINITY renders one unbounded line.
  // Required (not optional) so callers cannot silently drop the wire's value.
  width: number;
}

function pickJoiner(style: StripStyle, separator?: string): Joiner {
  // [LAW:dataflow-not-control-flow] joiner choice is data-driven; one branch
  // per shape, no nested conditionals.
  if (style === "capsule") return new CapsuleJoiner();
  if (style === "plain") {
    return new PlainJoiner(separator !== undefined ? { separator } : {});
  }
  return new PowerlineJoiner();
}

function toCell(seg: RenderedSegmentLike): RichText {
  // Padding mirrors the legacy buildLineFromSegments: one space on each side
  // of the segment text. The joiners sit between cells; padding sits inside.
  const padded = ` ${seg.text} `;
  const style = new Style({
    bgcolor: seg.bgHex || undefined,
    color: seg.fgHex || undefined,
  });
  return new RichText(padded, { style, end: "", noWrap: true });
}

/**
 * [LAW:single-enforcer] The one place RichText cells become an ANSI byte
 * string. Every render path (DSL RichText[] via the template-engine
 * pipeline, buildLineStrip's input-shape adapter, debug per-segment
 * serialization) flows through here. The wrap dispatch lives here too:
 * finite width → FlexStrip (rich-js owns the wrap algebra); infinite
 * width → Strip.
 *
 * [LAW:dataflow-not-control-flow] The dispatch is on the value, not on a
 * flag. There is no `wrap: boolean` knob; presence of a finite width IS
 * the decision.
 */
export function renderStripCells(
  cells: readonly RichText[],
  options: BuildLineOptions,
): string {
  if (cells.length === 0) return "";
  const joiner = pickJoiner(options.style, options.separator);
  if (Number.isFinite(options.width)) {
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
  return renderStripCells(segments.map(toCell), options);
}
