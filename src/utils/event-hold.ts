// How long an event-shaped error shows: the daemon's one rule for it, read by
// every render against its own instant.
//
// [LAW:no-ambient-temporal-coupling] Each render asks whether its instant is
// inside the hold, so a pushed frame and a statusline request agree by
// construction. Past the hold a request is still owed the error until an
// answer has carried it, because Claude Code with no
// `statusLine.refreshInterval` asks only on events, and an error that expired
// unseen would be silent. Its owner lets it go only once neither holds, so the
// facts carry an event only while some bar can show it.

import type { Instant } from "./instant.js";
import type { Drawing } from "../config/lanes.js";

// Seconds every render shows an event of the daemon's own (a pipe event, a
// renderer's end): long enough to read on a bar that redraws only on events.
// That it is seen at all is the owed half of the hold.
export const DAEMON_EVENT_HOLD_S = 60;

export interface HeldEvent {
  // What the bar presents.
  readonly text: string;
  // When it began to show, which its hold runs from.
  readonly at: Instant;
  // [LAW:types-are-the-program] Joined events can have the same instant and
  // clipped text. Advance their own revision without relying on a clock.
  // Other event sources and older saved click records have no revision.
  readonly revision?: number;
  // Whether a confirmed client write carried it.
  readonly answered: boolean;
}

export type DaemonEventKind =
  | "renderer-ended"
  | "act-failed"
  | "launch-pipes"
  | "task-threw";

// [LAW:types-are-the-program] An event of the daemon's own, as its facts
// carry it and a frame that showed it names it back to its owner: the kind
// that owns it, and the subject it is about (the task that threw, a pipe
// event's words; a kind that holds one event at a time is about itself).
// Session click errors never leave the renderer's delivery record.
export type DaemonEvent<Kind extends DaemonEventKind = DaemonEventKind> =
  Kind extends DaemonEventKind
    ? {
        readonly kind: Kind;
        readonly about: string;
        readonly event: HeldEvent;
      }
    : never;

// [LAW:single-enforcer] Whether two daemon events are one: the same subject
// of one kind, and the same occurrence of it. The feed's cover of an answer
// and the owner's acknowledgement of it both ask this.
export const sameDaemonEvent = (a: DaemonEvent, b: DaemonEvent): boolean =>
  a.kind === b.kind && a.about === b.about && sameOccurrence(a.event, b.event);

// [LAW:single-enforcer] How every event of the daemon's own says it recurred
// `more` times since it was last shown.
export const recurrence = (more: number): string =>
  more === 0 ? "" : more === 1 ? " again" : ` ${more} more times`;

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
