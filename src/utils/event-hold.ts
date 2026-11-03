// How long an event-shaped error shows: the daemon's one rule for it, read by
// every render against its own instant.
//
// [LAW:no-ambient-temporal-coupling] Nothing is timed and nothing clears the
// record: each render asks whether its instant is inside the hold, so a pushed
// frame and a statusline request agree by construction. Past the hold a
// request is still owed the error until an answer has carried it, because
// Claude Code with no `statusLine.refreshInterval` asks only on events, and an
// error that expired unseen would be silent.

import type { Instant } from "./instant.js";
import type { Drawing } from "../config/lanes.js";

export interface HeldEvent {
  // When the event happened.
  readonly at: Instant;
  // Whether a request's answer has carried it to its client.
  readonly answered: boolean;
}

// `held` inside the hold, `owed` past it to a request no answer has served,
// `over` once neither holds.
export type EventHold = "held" | "owed" | "over";

// [LAW:single-enforcer] The one rule for whether a render shows an event.
export function eventHoldAt(
  event: HeldEvent,
  holdS: number,
  at: Instant,
  // A request answers a client, a frame a feed draws does not, so only a
  // request is owed the event past the hold.
  render: Drawing["by"],
): EventHold {
  if (at < event.at + holdS) return "held";
  return render === "request" && !event.answered ? "owed" : "over";
}
