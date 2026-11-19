import type { SessionId } from "../daemon/foundations/session-id.js";
import { effectsUrl, type VERB_SET_STATE } from "../click/wire.js";

// [LAW:types-are-the-program] A generated click carries its drawing session
// and the arguments that were on screen. A literal href carries only its URL.
export interface DrawnAction {
  readonly kind: "action";
  readonly effect: {
    readonly verb: typeof VERB_SET_STATE;
    readonly args: readonly [session: SessionId, key: string, value: string];
  };
}

export type LinkTarget =
  | DrawnAction
  | { readonly kind: "href"; readonly url: string };

// Strings carry ordinary hrefs and the remaining generated URLs. Only the
// host presentation boundary signs a click address.
export type DrawnLink = string | LinkTarget;

export function hrefOfDrawnLink(link: DrawnLink): string {
  if (typeof link === "string") return link;
  if (link.kind === "href") return link.url;
  return effectsUrl([link.effect]);
}
