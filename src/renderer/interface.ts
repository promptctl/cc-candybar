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
import type { SessionId } from "../daemon/session-id";
import type { SourceId, WorldState } from "../facts/world-state";
import type { Frame } from "../render/frame";
import type { Instant } from "../utils/instant";
import type { Field } from "../utils/logfmt";
import type { CheckedRenderRequest } from "./request-context";

// Which request a statusline frame answers: the host's count of the requests
// it received, in arrival order.
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
      // the view that config opened, from the world state the renderer holds
      // for the session.
      readonly kind: "request";
      readonly id: RequestId;
      readonly context: CheckedRenderRequest;
      // The monotonic moment the request's wait ends, from its client's
      // deadline: the renderer still waits inside this turn, over the world
      // states the host hands in, until the mailbox moves the wait, so its
      // turns overlap: other inputs, other requests' included, arrive while
      // this one waits.
      readonly waitEndsAt: number;
    }
  | {
      // A session's world state moved since the one the renderer holds: read
      // at the keys of the newest `config` the host delivered for it.
      readonly kind: "world-state";
      readonly worldState: WorldState;
    }
  | {
      // The host ended the session: the renderer lets go of what it holds
      // of it.
      readonly kind: "retire";
      readonly session: SessionId;
    }
  | {
      readonly kind: "effect-done";
      readonly of: EffectId;
      readonly outcome: EffectOutcome;
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

// A source the renderer's state needs read for one session: today a plugin
// source, at its folder's storage key, named by the variable that reads it.
export interface Subscription {
  readonly kind: "plugin";
  readonly source: SourceId;
  readonly storage: StorageKey;
}

// [LAW:one-source-of-truth] Whole, replacing the last: what every session the
// renderer holds needs read. The host diffs it; nothing is declared by
// message. A session absent from it needs nothing read.
export interface Subscriptions {
  readonly sources: Readonly<Record<SessionId, readonly Subscription[]>>;
}

export interface RendererOutput {
  readonly effects: readonly Effect[];
  readonly subscriptions: Subscriptions;
  readonly record: TurnRecord;
}

// [LAW:no-silent-failure] A turn that threw, with the record it reached, so the
// host still writes what the turn learned before it stopped.
export class TurnThrew extends Error {
  constructor(
    readonly record: TurnRecord,
    readonly thrown: unknown,
  ) {
    super(thrown instanceof Error ? thrown.message : String(thrown));
    this.name = "TurnThrew";
  }
}
