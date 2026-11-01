// A strip's cell from a plain segment, padded inside its own style as the
// layout pads one: the joiners sit between cells and padding inside them.
import { RichText, Style } from "@promptctl/rich-js";

export interface PlainSegment {
  readonly text: string;
  readonly bgHex?: string;
  readonly fgHex?: string;
}

export const stripCell = (
  { text, bgHex, fgHex }: PlainSegment,
  padding: number,
): RichText =>
  new RichText(text, {
    style: new Style({ bgcolor: bgHex, color: fgHex }),
    end: "",
    overflow: "ignore",
  }).pad(padding);
