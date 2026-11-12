// The renderer's click turn: what a click means is the verb its link names,
// acted on in this turn, so the turn's output reads the subscriptions as they
// stand once the act has landed (its commit, and its view's follow), and
// carries the copies it asked for.

import { noteFacts, type RequestFacts } from "../daemon/request-event.js";
import { BadVerbArgs } from "../daemon/verb-error.js";
import type { Event } from "./interface.js";
import type { MainRendererParts } from "./verbs.js";

type ClickEvent = Extract<Event, { kind: "click" }>;

// [LAW:no-silent-failure] A verb the table does not have is the click's bad
// request; whatever the act throws is the turn's throw, which the host turns
// into the click's reply by its class.
// [LAW:effects-at-boundaries] What the act asks the clipboard to hold goes
// to `copy`, which returns it as the turn's effect.
export async function clickTurn(
  { verbs, menuIdle }: Pick<MainRendererParts, "verbs" | "menuIdle">,
  { verb, value, session, arrival, gone }: ClickEvent,
  record: RequestFacts,
  copy: (text: string) => void,
): Promise<void> {
  const handler = verbs.handler(verb);
  if (handler === undefined)
    throw new BadVerbArgs(`unknown click verb: ${verb}`);
  // A session that passed the checkpoint is pending on its idle clock until
  // the click settles.
  const pending = session?.ok ? session.id : null;
  if (pending !== null) menuIdle.clickArrived(pending);
  try {
    await handler(value, {
      arrival,
      placeWaited: (ms) => noteFacts(record, { placeWait: `${ms}ms` }),
      gatherTook: (ms) => noteFacts(record, { gather: `${ms}ms` }),
      turnWaited: (ms) => noteFacts(record, { turnWait: `${ms}ms` }),
      clientGone: gone,
      copy,
    });
  } finally {
    if (pending !== null) menuIdle.clickSettled(pending);
  }
}
