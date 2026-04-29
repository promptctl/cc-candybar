import {
  Strip,
  StripCell,
  Style,
  PowerlineJoiner,
  CapsuleJoiner,
  PlainJoiner,
  renderToString,
  type Joiner,
  type ColorSystemSpec,
} from "rich-js";

export interface RenderedSegmentLike {
  type: string;
  text: string;
  bgHex?: string;
  fgHex?: string;
}

export type StripStyle = "powerline" | "capsule" | "plain";

interface BuildLineOptions {
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
 * Renders a row of segments into a single ANSI-encoded line using rich-js
 * Strip + Joiner + renderToString. Replaces the old hand-rolled
 * formatSegment / buildLineFromSegments path.
 */
export function buildLineStrip(
  segments: readonly RenderedSegmentLike[],
  options: BuildLineOptions,
): string {
  if (segments.length === 0) return "";
  const cells = segments.map(toStripCell);
  const joiner = pickJoiner(options.style, options.separator);
  const strip = new Strip(cells, joiner);
  return renderToString(strip, {
    colorSystem: options.colorCompatibility,
    endWithNewline: false,
  });
}
