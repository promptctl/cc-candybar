// The renderer's click turn: what a click means is the verb its link names,
// acted on in this turn, so the turn's output reads the subscriptions as they
// stand once the act has landed (its commit).

import type { Effect, Event } from "../renderer-interface/interface.js";
import type { MainRendererParts } from "./verbs/port.js";
import type { RequestFacts } from "../daemon/foundations/request-event.js";

type ClickEvent = Extract<Event, { kind: "click" }>;

export function clickTurn(
  { verbs }: Pick<MainRendererParts, "verbs">,
  { click, arrival, context }: ClickEvent,
  // Where the click's config changes go, and what its turn's record notes,
  // kept by the turn even when the handler throws.
  effects: Effect[],
  record: RequestFacts,
): void {
  verbs.click(click, { arrival, context, effects, record });
}
