// A connection's lifecycle as one value, and the one table that moves it. A
// connection reads one frame, and that frame says whether a client waits for
// its answer: a request's client holds the socket until answered, while the URL
// handler app writes its frame and hangs up by design. Everything after the
// read (an answer, the backstop, a subscription, a held request, a close) is an
// event this table maps to the next state and the effects of that step. The
// connection (src/daemon/connection.ts) only performs them.

import type { Lane } from "../config/lanes.js";
import type { HandledRequest, Reply } from "./reply.js";
import type { SessionId } from "./session-id.js";

// [LAW:types-are-the-program] One state, so no pair of flags can disagree.
// `lapsed` is whether the backstop fired: past the deadline, whether or not
// anyone was told.
export type ConnectionState =
  // No frame yet: a client is taken to wait.
  | { readonly kind: "awaiting" }
  // A waiting client's frame is read, and its answer is not yet written.
  | { readonly kind: "answering" }
  // A url frame is read, and nobody waits for its answer.
  | { readonly kind: "unattended"; readonly lapsed: boolean }
  // The one answer is written: the reply's own, or the backstop's TIMEOUT.
  | { readonly kind: "answered"; readonly by: "reply" | "backstop" }
  // A request answered past the backstop by design (a recording).
  | { readonly kind: "held" }
  // The subscription stands: frames until the subscriber closes.
  | { readonly kind: "streaming"; readonly unsubscribe: () => void }
  | { readonly kind: "closed"; readonly lapsed: boolean };

export type ConnectionEvent =
  // The one frame is read.
  | { readonly kind: "read"; readonly waits: boolean }
  // The one frame did not parse.
  | { readonly kind: "unreadable"; readonly answer: Reply }
  // The backstop fired.
  | { readonly kind: "deadline"; readonly answer: Reply }
  // What the frame's handling settled with: a reply, a subscribe or held work.
  // A held request's work settles with a reply too.
  | HandledRequest
  // The feed took the subscription: `unsubscribe` ends it.
  | { readonly kind: "subscribed"; readonly unsubscribe: () => void }
  // The handling, or a held request's work, threw.
  | { readonly kind: "threw"; readonly answer: Reply }
  // The frame's handling is over, however it ended.
  | { readonly kind: "settled" }
  // The peer left: its socket errored or closed.
  | { readonly kind: "close" };

// [LAW:effects-at-boundaries] What a step asks the connection to do.
export type ConnectionEffect =
  // Write this answer and end the stream; its exit runs on that flush.
  | { readonly kind: "answer"; readonly answer: Reply }
  // A reply that goes unwritten still carries its exit.
  | { readonly kind: "exit"; readonly code: number }
  // An exit whose reply will never be sent, said because a daemon told to
  // exit is staying up. [LAW:no-silent-failure]
  | { readonly kind: "exit-dropped" }
  | { readonly kind: "count-timeout" }
  | { readonly kind: "clear-backstop" }
  | { readonly kind: "leave-in-flight" }
  | {
      readonly kind: "attach";
      readonly sessionId: SessionId;
      readonly lane: Lane;
    }
  | {
      readonly kind: "start";
      readonly start: (left: AbortSignal) => Promise<Reply>;
    }
  | { readonly kind: "abort" }
  | { readonly kind: "unsubscribe"; readonly unsubscribe: () => void };

export interface Step {
  readonly next: ConnectionState;
  readonly effects: readonly ConnectionEffect[];
}

export const AWAITING: ConnectionState = { kind: "awaiting" };

// [LAW:one-source-of-truth] The backstop and in-flight are properties of the
// state, so they move only when a step crosses their line, and exactly once.
export const backstopArmed = (s: ConnectionState): boolean =>
  s.kind === "awaiting" ||
  s.kind === "answering" ||
  (s.kind === "unattended" && !s.lapsed);

export const inFlight = (s: ConnectionState): boolean =>
  s.kind !== "streaming" && s.kind !== "closed";

export const timedOut = (s: ConnectionState): boolean =>
  (s.kind === "answered" && s.by === "backstop") ||
  ((s.kind === "unattended" || s.kind === "closed") && s.lapsed);

// The peer left. A url frame's writer has not while its frame is handled,
// because its hang-up is the forwarder's design and keeps it unattended.
export const clientLeft = (s: ConnectionState): boolean => s.kind === "closed";

// A move to `next` with no effects of its own.
const to = (next: ConnectionState): Step => ({ next, effects: [] });

const answered = (by: "reply" | "backstop", answer: Reply): Step => ({
  next: { kind: "answered", by },
  effects: [{ kind: "answer", answer }],
});

// [LAW:dataflow-not-control-flow] The table: each (state, event) cell, and
// every cell not named leaves the state as it is and does nothing.
const cell = (s: ConnectionState, e: ConnectionEvent): Step => {
  switch (e.kind) {
    case "read":
      if (s.kind === "awaiting")
        return to(
          e.waits
            ? { kind: "answering" }
            : { kind: "unattended", lapsed: false },
        );
      // A frame read after the backstop answered: its work still runs, and its
      // answer goes nowhere. Who waits is still the frame's fact, so a url
      // frame's forwarder hanging up is no departure, and it stays in flight
      // until its click is handled.
      if (s.kind === "answered" && s.by === "backstop" && !e.waits)
        return to({ kind: "unattended", lapsed: true });
      return to(s);
    case "unreadable":
      return s.kind === "awaiting" ? answered("reply", e.answer) : to(s);
    case "deadline":
      if (s.kind === "awaiting" || s.kind === "answering") {
        const told = answered("backstop", e.answer);
        return {
          ...told,
          effects: [{ kind: "count-timeout" }, ...told.effects],
        };
      }
      if (s.kind === "unattended" && !s.lapsed) {
        // Nobody waits, so nobody is told: the deadline is only a fact.
        return {
          next: { kind: "unattended", lapsed: true },
          effects: [{ kind: "count-timeout" }],
        };
      }
      return to(s);
    case "reply":
      if (s.kind === "answering" || s.kind === "held")
        return answered("reply", e);
      if (
        (s.kind === "answered" && s.by === "backstop") ||
        (s.kind === "closed" && s.lapsed)
      ) {
        // [LAW:no-ambient-temporal-coupling] An exit is sequenced on its own
        // reply's flush (src/daemon/reply.ts), never on another answer's: a
        // client told TIMEOUT, hung up since or not, never hears this reply,
        // so its exit goes with it. A reply never reaches a url frame's
        // `closed`, which comes only once its handling settled.
        return {
          next: s,
          effects: e.exitAfterFlush === null ? [] : [{ kind: "exit-dropped" }],
        };
      }
      // The client hung up unanswered: nothing to write, but the exit is the
      // daemon's.
      if (s.kind === "closed")
        return {
          next: s,
          effects:
            e.exitAfterFlush === null
              ? []
              : [{ kind: "exit", code: e.exitAfterFlush }],
        };
      return to(s);
    case "subscribe":
      return s.kind === "answering"
        ? {
            next: s,
            effects: [{ kind: "attach", sessionId: e.sessionId, lane: e.lane }],
          }
        : to(s);
    case "subscribed":
      // [LAW:no-ambient-temporal-coupling] A subscription the feed took after
      // the connection moved on is ended, not dropped, whatever moved it.
      return s.kind === "answering"
        ? to({ kind: "streaming", unsubscribe: e.unsubscribe })
        : {
            next: s,
            effects: [{ kind: "unsubscribe", unsubscribe: e.unsubscribe }],
          };
    case "held":
      return s.kind === "answering"
        ? {
            next: { kind: "held" },
            effects: [{ kind: "start", start: e.start }],
          }
        : to(s);
    case "threw":
      return s.kind === "answering" || s.kind === "held"
        ? answered("reply", e.answer)
        : to(s);
    case "settled":
      return s.kind === "unattended"
        ? to({ kind: "closed", lapsed: s.lapsed })
        : to(s);
    case "close":
      if (s.kind === "unattended" || s.kind === "closed") return to(s);
      if (s.kind === "streaming")
        return {
          next: { kind: "closed", lapsed: false },
          effects: [{ kind: "unsubscribe", unsubscribe: s.unsubscribe }],
        };
      if (s.kind === "held")
        return {
          next: { kind: "closed", lapsed: false },
          effects: [{ kind: "abort" }],
        };
      return to({ kind: "closed", lapsed: timedOut(s) });
  }
};

// A step: the cell's own effects, after the lines it crosses.
export function step(s: ConnectionState, e: ConnectionEvent): Step {
  const { next, effects } = cell(s, e);
  const crossed: ConnectionEffect[] = [
    ...(backstopArmed(s) && !backstopArmed(next)
      ? [{ kind: "clear-backstop" } as const]
      : []),
    ...(inFlight(s) && !inFlight(next)
      ? [{ kind: "leave-in-flight" } as const]
      : []),
  ];
  return { next, effects: [...crossed, ...effects] };
}
