// The renderer interface (docs/design/host-and-renderer.md §7): the host hands
// a renderer inputs, and the renderer answers each with the effects it asks
// the host to perform, what it needs read, and the record of its turn.
//
// [LAW:one-way-deps] The host depends on this module and the renderer
// implements it; it imports only types, the vocabulary both sides speak: the
// session context, the world state, the frame, the instant.
// [LAW:types-are-the-program] The unions hold only the arms something produces
// and something consumes; each later step adds its own.

import type { StorageKey } from "../daemon/cache/managed-storage";
import type { ParsedSessionId, SessionId } from "../daemon/session-id";
import type { Failure } from "../daemon/verb-error";
import type { IdleSpan } from "../daemon/verbs";
import type { ClickArrival } from "../doctor/sightings";
import type { Run } from "../facts/source-identity";
import type { SourceId, WorldState } from "../facts/world-state";
import type { Frame } from "../render/frame";
import type { Instant } from "../utils/instant";
import type { Field } from "../utils/logfmt";
import type { CheckedRenderRequest } from "./request-context";

// Which request a statusline frame answers: the host's count of the requests
// of every kind it accepted, in arrival order, so renders' ids have gaps.
declare const REQUEST_ID: unique symbol;
export type RequestId = number & { readonly [REQUEST_ID]: true };

// An effect's name, minted by the renderer that returned it, which its
// `effect-done` carries back.
declare const EFFECT_ID: unique symbol;
export type EffectId = number & { readonly [EFFECT_ID]: true };

// [LAW:one-type-per-behavior] One interface over every transport: in process
// for now, a socket to the renderer's own process later.
export interface Renderer {
  answer(input: RendererInput): Promise<RendererOutput>;
}

export interface RendererInput {
  readonly kind: "event";
  readonly event: Event;
  // [LAW:effects-at-boundaries] The instant the turn runs at, read by the host:
  // the renderer reads no clock for it.
  readonly at: Instant;
}

export type Event =
  | {
      // What the session's config is made of, as its newest request names
      // it, delivered ahead of that request: its turn opens the session's
      // view, so the output names what the view reads before the request
      // waits on it. Until config discovery is the host's, it carries the
      // request's context, from which the renderer finds the config itself.
      readonly kind: "config";
      readonly context: CheckedRenderRequest;
      // [LAW:one-source-of-truth] The world state read at this context's own
      // keys: a session's context and its world state reach the renderer as
      // one value, so a renderer never holds a context beside a document read
      // at another request's keys.
      readonly worldState: WorldState;
    }
  | {
      // A request of a session whose `config` came before it: the turn draws
      // from the world state the renderer holds for the session.
      readonly kind: "request";
      readonly id: RequestId;
      readonly context: CheckedRenderRequest;
      // The instant the request's wait ends, from its client's deadline: the
      // renderer still waits inside this turn, over the world states the host
      // hands in, until the mailbox moves the wait, so its turns overlap:
      // other inputs, other requests' included, arrive while this one waits.
      readonly waitEndsAt: Instant;
    }
  | {
      // A session's world state moved since the one the renderer holds: read
      // at the keys of the newest `config` the host delivered for it.
      readonly kind: "world-state";
      readonly worldState: WorldState;
    }
  | {
      // The host ended the session: the renderer lets go of what it holds
      // of it, and its document goes however the turn ends, answered or
      // threw, so the host's next record for the session starts again at
      // seq 1.
      readonly kind: "retire";
      readonly session: SessionId;
    }
  | {
      readonly kind: "effect-done";
      // The session of the effect it reports on.
      readonly session: SessionId;
      readonly of: EffectId;
      readonly outcome: EffectOutcome;
    }
  | {
      // A click on a link the bar drew: the renderer decides what it means
      // and acts on it in this turn, so the output names what the act moved.
      readonly kind: "click";
      readonly verb: string;
      readonly value: string;
      // The click's session as it crossed the host's session-id checkpoint:
      // null when the click names none.
      readonly session: ParsedSessionId | null;
      readonly arrival: ClickArrival;
      // The request the click arrived in. Whether its client left or its
      // deadline passed is the host's to say, from the click's connection,
      // asked by this id while the turn waits for the click's place and its
      // journal turn.
      readonly id: RequestId;
    }
  | {
      // The session's idle clock ran out: the turn closes its menus as the
      // ✕ does.
      readonly kind: "menu-idle";
      readonly session: SessionId;
      // How long the session was idle when its clock ran out, for the close's
      // line. Whether it is still idle is read in the close's journal turn.
      readonly idle: IdleSpan;
    };

export type EffectOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly reason: string };

// [LAW:one-type-per-behavior] Every frame reaches its surface by `present`;
// the statusline's arm carries the request it answers.
export interface Present {
  readonly kind: "present";
  readonly id: EffectId;
  readonly session: SessionId;
  readonly surface: "statusline";
  readonly request: RequestId;
  readonly frame: Frame;
}

export type Effect = Present;

// [LAW:nothing-unseen] What a turn learned, in the order it learned it, which
// the host writes beside the input's event.
export type TurnRecord = readonly Field[];

// [LAW:types-are-the-program] A source the renderer's state needs read for
// one session: a plugin source, at its folder's storage key, named by the
// variable that reads it; or a `shell` or `file` run, named by its digest.
export type Subscription =
  | {
      readonly kind: "plugin";
      readonly source: SourceId;
      readonly storage: StorageKey;
    }
  | { readonly kind: "run"; readonly run: Run };

// [LAW:one-source-of-truth] Whole, replacing the last: what every session the
// renderer holds needs read. The host diffs it; nothing is declared by
// message. A session absent from it needs nothing read.
// [LAW:types-are-the-program] Keyed by session, so no session is listed twice,
// and a record, so it crosses a process as it is: a session absent is a key
// absent, never one holding `undefined`, which JSON does not carry.
export interface Subscriptions {
  readonly sources: Readonly<Record<SessionId, readonly Subscription[]>>;
}

// [LAW:no-silent-failure] Every turn answers, a turn that threw included: its
// failure as data, a class crossing no process, so `answer` never rejects.
// Either way it carries the record it reached and the open views'
// subscriptions as they stand after it: an act can land before its turn
// throws (a click that committed and followed its view), and its view is read
// all the same.
export type RendererOutput = {
  readonly subscriptions: Subscriptions;
  readonly record: TurnRecord;
} & (
  | { readonly kind: "answered"; readonly effects: readonly Effect[] }
  | { readonly kind: "threw"; readonly failure: Failure }
);
