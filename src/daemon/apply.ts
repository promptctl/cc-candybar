// [LAW:dataflow-not-control-flow][LAW:types-are-the-program] Apply: every
// source of change reaches the daemon's state as one arm of a closed Event
// union, and one table of arms is the only consumer. The table is keyed by
// every kind the union has, so adding a source of change is a compile error
// here until its arm exists, and no arm is a default. The journal's turn
// (src/daemon/journal-turns.ts) is the queue its click and menu-idle arms
// write in.
//
// An arm joins the union when its source is routed through Apply, and not
// before: an arm with no producer is a handler nothing can reach.

import type { ClickArrival } from "../doctor/sightings";
import type { Instant } from "../utils/instant.js";
import type { DaemonParts } from "./daemon-parts.js";
import { answerRequest, type RequestAnswer } from "./draw-bar.js";
import type { ClickAsker } from "./journal-turns.js";
import type { RequestFacts } from "./request-event.js";
import type { CheckedRenderRequest } from "./render-checkpoint.js";
import {
  closeIdleMenus,
  type ClickVerb,
  type IdleClose,
} from "./verbs/index.js";

export type Event =
  | {
      readonly kind: "request";
      readonly req: CheckedRenderRequest;
      readonly at: Instant;
      // When the request's wait ends (src/daemon/request-deadline.ts).
      readonly waitEndsAt: number;
      readonly facts: RequestFacts;
    }
  | {
      readonly kind: "click";
      readonly verb: ClickVerb;
      readonly value: string;
      readonly arrival: ClickArrival;
      // Where the click's waits are reported, and whether its client left.
      readonly asker: ClickAsker;
    }
  | {
      readonly kind: "menu-idle";
      readonly session: string;
      readonly idle: IdleClose;
    };

// What applying each kind answers its source with.
interface Applied {
  readonly request: RequestAnswer;
  readonly click: void;
  readonly "menu-idle": void;
}

// [LAW:types-are-the-program] One arm per kind of `E`, none missing and none
// extra: a union widened by an arm fails to build an `ApplyArms` until the arm
// is written.
export type ApplyArms<E extends { readonly kind: string }> = {
  readonly [K in E["kind"]]: (
    event: Extract<E, { readonly kind: K }>,
    parts: DaemonParts,
  ) => Promise<K extends keyof Applied ? Applied[K] : never>;
};

export const ARMS: ApplyArms<Event> = {
  // [LAW:single-enforcer] exception: the request takes no turn yet, so its
  // writes (the session's render origin and client hints) still land outside
  // one. A click holds the turn across its launches, and a render behind it
  // would stall the bar; the writes join the turn once launches leave it as
  // effects.
  request: ({ req, at, waitEndsAt, facts }, parts) =>
    answerRequest(parts, req, at, waitEndsAt, facts),
  click: ({ verb, value, arrival, asker }, { verbCtx }) =>
    verb.run(value, {
      ...verbCtx,
      arrival,
      placeWaited: asker.placed,
      gatherTook: asker.gathered,
      turnWaited: asker.waited,
      clientGone: asker.gone,
    }),
  "menu-idle": ({ session, idle }, { verbCtx }) =>
    closeIdleMenus(session, idle, verbCtx),
};

// [LAW:types-are-the-program] Generic over the kind, so the arm `ARMS[kind]`
// picks and the answer it gives are the ones `ApplyArms` pairs with it.
export function apply<K extends Event["kind"]>(
  event: Extract<Event, { readonly kind: K }>,
  parts: DaemonParts,
): Promise<Applied[K]> {
  const arm: ApplyArms<Event>[K] = ARMS[event.kind];
  return arm(event, parts);
}
