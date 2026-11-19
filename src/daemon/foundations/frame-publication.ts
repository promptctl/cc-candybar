import type { LinkSigner } from "../../click/link-signer.js";
import { hrefOfDrawnLink } from "../../render/drawn-link.js";
import { isBarLink } from "../../click/wire.js";
import { parseFrame, type Frame, type WireFrame } from "../../render/frame.js";

export type PublishFrame = (wire: WireFrame) => Frame<string>;

// [LAW:single-enforcer] Both host presentation paths publish the same
// clickable addresses before encoding. Links of other schemes belong to the
// terminal as drawn. The caller supplies the daemon or preview signer.
export function publishingFrames(
  signer: Pick<LinkSigner, "signLink">,
): PublishFrame {
  return (wire) => {
    const frame = parseFrame(wire);
    return {
      ...frame,
      rows: frame.rows.map((row) => ({
        ...row,
        runs: row.runs.map(({ link, ...run }) => {
          if (link === undefined) return run;
          const href = hrefOfDrawnLink(link);
          return {
            ...run,
            link: isBarLink(href) ? signer.signLink(href) : href,
          };
        }),
      })),
    };
  };
}
