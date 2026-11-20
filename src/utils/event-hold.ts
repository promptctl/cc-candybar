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

// Seconds every render shows an event of the daemon's own (a pipe event, a
// renderer's end): long enough to read on a bar that redraws only on events.
// That it is seen at all is the owed half of the hold.
export const DAEMON_EVENT_HOLD_S = 60;

export interface HeldEvent {
  // What the bar presents.
  readonly text: string;
  // When the event happened.
  readonly at: Instant;
  // [LAW:types-are-the-program] Joined events can have the same instant and
  // clipped text. Advance their own revision without relying on a clock.
  // Other event sources and older saved click records have no revision.
  readonly revision?: number;
  // Whether a confirmed client write carried it.
  readonly answered: boolean;
}

// [LAW:types-are-the-program] A frame names the daemon's occurrence and its
// owner. Session click errors never leave the renderer's delivery record.
export interface DisplayedEvent {
  readonly kind: "launch-pipes" | "renderer-ended" | "act-failed";
  readonly event: HeldEvent;
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

// A diagnostic is also part of session state and renderer input. Bound its
// UTF-16 units before composing it, including when the saved record predates
// this limit. Keep the beginning and outcome of one oversized message.
const TEXT_LIMIT = 2048;
const OMITTED = "…\n";

export function heldEventText(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  const split = Math.floor((TEXT_LIMIT - OMITTED.length - 1) / 2);
  const tail = TEXT_LIMIT - OMITTED.length - 1 - split;
  return `${text.slice(0, split)}\n${OMITTED}${text.slice(-tail)}`.toWellFormed();
}

function appendText(previous: string | null, text: string): string {
  if (previous === null) return heldEventText(text);
  const room = TEXT_LIMIT - text.length;
  if (previous.length + 1 <= room) return `${previous}\n${text}`;
  if (room < OMITTED.length) return heldEventText(text);
  const tail = room - OMITTED.length - 1;
  return tail > 0
    ? `${OMITTED}${previous.slice(-tail)}\n${text}`.toWellFormed()
    : `${OMITTED}${text}`;
}

// [LAW:single-enforcer] The one rule for an event that follows another: while
// the last is still owed to a client it joins it, so failures that land
// apart — a click's, then its run's — show together up to the text budget.
// Once an answer has carried them, the next starts afresh.
export function joinedEvent(
  last: HeldEvent | null,
  text: string,
  at: Instant,
): HeldEvent {
  return {
    text: appendText(last === null || last.answered ? null : last.text, text),
    at,
    revision: (last?.revision ?? 0) + 1,
    answered: false,
  };
}

// [LAW:single-enforcer] The one rule for which answer marks an event: one that
// carried the latest event, not yet marked. A newer event since stays unmarked.
export function answeredBy(last: HeldEvent, shown: HeldEvent): boolean {
  return !last.answered && sameOccurrence(last, shown);
}

export function sameOccurrence(a: HeldEvent, b: HeldEvent): boolean {
  return a.at === b.at && a.text === b.text && a.revision === b.revision;
}
