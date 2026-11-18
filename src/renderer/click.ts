// The renderer's click turn: what a click means is the verb its link names,
// acted on in this turn, so the turn's output reads the subscriptions as they
// stand once the act has landed (its commit).

import { BadVerbArgs } from "../daemon/foundations/verb-error.js";
import type { Settled, Event } from "../renderer-interface/interface.js";
import type { MainRendererParts } from "./verbs/port.js";
import type { RequestFacts } from "../daemon/foundations/request-event.js";

type ClickEvent = Extract<Event, { kind: "click" }>;

// [LAW:no-silent-failure] A verb the table does not have is the click's bad
// request; whatever the act throws is the turn's throw, which the renderer
// classifies as the turn's failure and the host turns into the click's reply
// by its kind.
export function clickTurn(
  { verbs }: Pick<MainRendererParts, "verbs">,
  { verb, value, arrival, context }: ClickEvent,
  // Where the click's config changes go, and what its turn's record notes,
  // kept by the turn even when the handler throws.
  effects: Settled[],
  record: RequestFacts,
): void {
  const handler = verbs.handler(verb);
  if (handler === undefined)
    throw new BadVerbArgs(`unknown click verb: ${verb}`);
  handler(value, { arrival, context, effects, record });
}
