import type { FrameSource, LinkSigner } from "../../click/link-signer.js";
import { publishedHref } from "../../render/drawn-link.js";
import { isBarLink } from "../../click/wire.js";
import { parseFrame, type Frame, type WireFrame } from "../../render/frame.js";

export type PublishFrame = (
  wire: WireFrame,
  source: FrameSource,
) => Frame<string>;

// [LAW:single-enforcer] Both host presentation paths publish the same
// clickable addresses before encoding. Links of other schemes belong to the
// terminal as drawn. The caller supplies the daemon or preview signer.
export function publishingFrames(
  signer: Pick<LinkSigner, "sign" | "signLink">,
) {
  return (wire: WireFrame, source?: FrameSource): Frame<string> => {
    const frame = parseFrame(wire);
    return {
      ...frame,
      rows: frame.rows.map((row) => ({
        ...row,
        runs: row.runs.map(({ link, ...run }) => {
          if (link === undefined) return run;
          const href = publishedHref(link, signer.sign);
          // [LAW:types-are-the-program] Authored hrefs keep their legacy
          // signature. The private typed target alone carries the draw's source.
          const issuer =
            typeof link !== "string" && link.kind !== "href"
              ? source
              : undefined;
          return {
            ...run,
            link: isBarLink(href) ? signer.signLink(href, issuer) : href,
          };
        }),
      })),
    };
  };
}
