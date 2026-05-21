import {
  Strip,
  StripCell,
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

export interface BuildLineOptions {
  style: StripStyle;
  colorCompatibility: ColorSystemSpec;
  separator?: string;
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

function toStripCell(seg: RenderedSegmentLike): StripCell {
  // Padding mirrors the legacy buildLineFromSegments: one space on each side
  // of the segment text. The joiners sit between cells; padding sits inside.
  const padded = ` ${seg.text} `;
  const style = new Style({
    bgcolor: seg.bgHex || undefined,
    color: seg.fgHex || undefined,
  });
  return new StripCell(padded, style);
}

/**
 * [LAW:single-enforcer] The one place StripCells become an ANSI byte string.
 * Every render path (legacy SegmentData via buildLineStrip, DSL StripCell[] via
 * the template-engine pipeline, the parity harness) renders through here, so
 * "byte-identical output" is a real theorem rather than two serializers that
 * could drift.
 */
export function renderStripCells(
  cells: readonly StripCell[],
  options: BuildLineOptions,
): string {
  if (cells.length === 0) return "";
  const joiner = pickJoiner(options.style, options.separator);
  const strip = new Strip([...cells], joiner);
  return renderToString(strip, {
    colorSystem: options.colorCompatibility,
  });
}

/**
 * Renders a row of segments into a single ANSI-encoded line using rich-js
 * Strip + Joiner + renderToString. Replaces the old hand-rolled
 * formatSegment / buildLineFromSegments path.
 */
export function buildLineStrip(
  segments: readonly RenderedSegmentLike[],
  options: BuildLineOptions,
): string {
  return renderStripCells(segments.map(toStripCell), options);
}

/**
 * Renders a row of segments into one or more wrapped lines using rich-js
 * FlexStrip. Each wrapped row reuses the same Joiner — start-cap, mid-join,
 * and end-cap fire at every line boundary, so wrapped rows look identical
 * to natural endpoints. Replaces the manual currentLineWidth tracking in
 * generateAutoWrapStatusline / calculateSegmentWidth.
 *
 * Returned string has wrapped rows joined by `\n` with no trailing newline,
 * matching buildLineStrip's contract for the caller.
 */
export function buildFlexStripLines(
  segments: readonly RenderedSegmentLike[],
  options: BuildLineOptions & { width: number },
): string {
  if (segments.length === 0) return "";
  const cells = segments.map(toStripCell);
  const joiner = pickJoiner(options.style, options.separator);
  const flex = new FlexStrip(cells, { joiner });
  const out = renderToString(flex, {
    width: options.width,
    colorSystem: options.colorCompatibility,
  });
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}
