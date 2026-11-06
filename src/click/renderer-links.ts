import type { RendererAddress } from "../daemon/home.js";
import type { LinkSigner } from "./link-signer.js";

// [LAW:locality-or-seam] What makes a link this renderer's: the name it is
// addressed to, which chooses the process a click reaches, and the key that
// signs what it runs, which that process verifies. A process has one of each
// for its life, so a compile shared across directories carries it as it
// carries nothing else. One value, so a fact every link of a renderer carries
// joins it here rather than beside it at every call that compiles.
export interface RendererLinks {
  readonly to: RendererAddress;
  readonly signer: LinkSigner;
}
