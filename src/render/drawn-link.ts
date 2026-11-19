import type { SessionId } from "../daemon/foundations/session-id.js";
import {
  effectsUrl,
  VERB_REPO_CONFIG,
  type VERB_SET_STATE,
} from "../click/wire.js";
import type { RepoAnswer } from "../config/loader/repo-gate.js";

// [LAW:types-are-the-program] A generated click carries its drawing session
// and the arguments that were on screen. A literal href carries only its URL.
export interface DrawnAction {
  readonly kind: "action";
  readonly effect: {
    readonly verb: typeof VERB_SET_STATE;
    readonly args: readonly [session: SessionId, key: string, value: string];
  };
}

export interface DrawnRepoAnswer {
  readonly kind: "repo-answer";
  readonly session: SessionId;
  readonly dir: string;
  readonly answer: RepoAnswer;
}

export type LinkTarget =
  | DrawnAction
  | DrawnRepoAnswer
  | { readonly kind: "href"; readonly url: string };

// Strings carry ordinary hrefs and the remaining generated URLs. Only the
// host presentation boundary signs a click address.
export type DrawnLink = string | LinkTarget;

export function hrefOfDrawnLink(link: DrawnLink): string {
  if (typeof link === "string") return link;
  if (link.kind === "href") return link.url;
  if (link.kind === "repo-answer") return repoAnswerUrl(link, "");
  return effectsUrl([link.effect]);
}

export function repoAnswerUrl(
  { session, dir, answer }: DrawnRepoAnswer,
  proof: string,
): string {
  return effectsUrl([
    { verb: VERB_REPO_CONFIG, args: [session, dir, answer, proof] },
  ]);
}
