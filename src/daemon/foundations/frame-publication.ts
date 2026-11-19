import type { LinkSigner } from "../../click/link-signer.js";
import { isBarLink } from "../../click/wire.js";
import { parseFrame, type Frame, type WireFrame } from "../../render/frame.js";

export type PublishFrame = (wire: WireFrame) => Frame;

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
        runs: row.runs.map((run) =>
          run.link !== undefined && isBarLink(run.link)
            ? { ...run, link: signer.signLink(run.link) }
            : run,
        ),
      })),
    };
  };
}
