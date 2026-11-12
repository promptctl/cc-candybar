// The renderer's click turn: what a click means is the verb its link names,
// acted on in this turn, so the turn's output reads the subscriptions as they
// stand once the act has landed (its commit, and its view's follow).

import { noteFacts, type RequestFacts } from "../daemon/request-event.js";
import { BadVerbArgs } from "../daemon/verb-error.js";
import type { ClickArrival } from "../doctor/sightings";
import type { Event } from "./interface.js";
import type { MainRendererParts } from "./verbs.js";

type ClickEvent = Extract<Event, { kind: "click" }>;

// [LAW:dataflow-not-control-flow] The field a click records the verb it runs
// under, by how it arrived: a status-line click has already recorded its own
// verb, so the one its link runs is `linkVerb`.
const VERB_FACT: Readonly<Record<ClickArrival["via"], string>> = {
  link: "verb",
  "tmux-status": "linkVerb",
};

// [LAW:no-silent-failure] A verb the table does not have is the click's bad
// request; whatever the act throws is the turn's throw, which the host turns
// into the click's reply by its class.
export async function clickTurn(
  { verbs, menuIdle }: Pick<MainRendererParts, "verbs" | "menuIdle">,
  { verb, value, session, arrival, gone }: ClickEvent,
  record: RequestFacts,
): Promise<void> {
  const handler = verbs.handler(verb);
  if (handler === undefined)
    throw new BadVerbArgs(`unknown click verb: ${verb}`);
  noteFacts(record, { [VERB_FACT[arrival.via]]: verb });
  // A session that passed the checkpoint is recorded and is pending on its
  // idle clock until the click settles; one that failed is never recorded,
  // and a click naming none records `sid=-`.
  const pending = session?.ok ? session.id : null;
  if (session === null) noteFacts(record, { sid: "-" });
  else if (pending !== null) {
    noteFacts(record, { sid: pending });
    menuIdle.clickArrived(pending);
  }
  try {
    await handler(value, {
      arrival,
      placeWaited: (ms) => noteFacts(record, { placeWait: `${ms}ms` }),
      gatherTook: (ms) => noteFacts(record, { gather: `${ms}ms` }),
      turnWaited: (ms) => noteFacts(record, { turnWait: `${ms}ms` }),
      clientGone: gone,
    });
  } finally {
    if (pending !== null) menuIdle.clickSettled(pending);
  }
}
