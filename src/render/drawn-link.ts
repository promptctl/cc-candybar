import type { SessionId } from "../daemon/foundations/session-id.js";
import {
  effectsUrl,
  repoAnswerFields,
  runLinkFields,
  VERB_RUN,
  VERB_REPO_CONFIG,
  type Effect,
  type EvaluatedRun,
} from "../click/wire.js";
import type { LinkSigner } from "../click/link-signer.js";
import type { GestureName } from "../click/gesture.js";
import type { RepoAnswer } from "../config/loader/repo-gate.js";

export interface DrawnRun {
  readonly kind: "run";
  readonly session: SessionId;
  readonly action: string;
  readonly declaration: string;
  readonly evaluated: EvaluatedRun;
}

export type DrawnEffect =
  | (Omit<Effect, "verb"> & {
      readonly verb: Exclude<
        Effect["verb"],
        typeof VERB_RUN | typeof VERB_REPO_CONFIG
      >;
    })
  | DrawnRun;

// [LAW:types-are-the-program] A generated click carries its drawing session
// and the arguments that were on screen. A literal href carries only its URL.
export interface DrawnAction {
  readonly kind: "action";
  readonly effects: readonly DrawnEffect[];
  readonly description?: string;
  // A region a template bound by name carries it, and what its other gestures
  // run: what the pane's hit map and its hover read. A region drawn from
  // effects alone has neither, so it is never hovered and answers a click only.
  readonly region?: Region;
}

// The action a region is bound to and what each of its other gestures runs.
export interface Region {
  readonly name: string;
  readonly gestures: Readonly<Record<GestureName, readonly DrawnEffect[]>>;
}

export function actionTarget(
  effects: readonly DrawnEffect[],
  description?: string,
  region?: Region,
): DrawnAction {
  return {
    kind: "action",
    effects,
    ...(description === undefined ? {} : { description }),
    ...(region === undefined ? {} : { region }),
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

// The textual destination for preview and inspection, before publication.
export function hrefOfDrawnLink(link: DrawnLink): string {
  return drawnHref(link, () => "");
}

// [LAW:single-enforcer] Sensitive effects get their proof only when the host
// publishes typed frame data. An authored href supplies its own destination.
export function publishedHref(
  link: DrawnLink,
  proof: LinkSigner["sign"],
): string {
  return drawnHref(link, proof);
}

function drawnHref(link: DrawnLink, proof: LinkSigner["sign"]): string {
  if (typeof link === "string") return link;
  switch (link.kind) {
    case "href":
      return link.url;
    case "repo-answer": {
      const { session, dir, answer } = link;
      return effectsUrl([
        {
          verb: VERB_REPO_CONFIG,
          args: [
            session,
            dir,
            answer,
            proof(repoAnswerFields(session, dir, answer)),
          ],
        },
      ]);
    }
    case "action":
      return effectsUrl(
        link.effects.map((effect) => emitted(effect, proof)),
        link.description,
      );
  }
}

function emitted(effect: DrawnEffect, proof: LinkSigner["sign"]): Effect {
  if ("verb" in effect) return effect;
  const { session, action } = effect;
  const evaluated = JSON.stringify(effect.evaluated);
  const mac = proof(runLinkFields(effect, evaluated));
  return { verb: VERB_RUN, args: [session, action, evaluated, mac] };
}
