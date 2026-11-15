// The renderer interface (docs/design/host-and-renderer.md §7): the host hands
// a renderer inputs, and the renderer answers each with the effects it asks
// the host to perform, what it needs read, and the record of its turn.
//
// [LAW:one-way-deps] The host depends on this module and the renderer
// implements it; it imports only types, the vocabulary both sides speak: the
// session context, the world state, the frame, the instant.
// [LAW:types-are-the-program] The unions hold only the arms something produces
// and something consumes; each later step adds its own.

import type {
  ParsedSessionId,
  SessionId,
} from "../daemon/foundations/session-id";
import type { Failure } from "../daemon/foundations/verb-error";
import type { ClickArrival } from "../doctor/sightings";
import type { Run } from "../facts/source-identity";
import type { SourceId, WorldState } from "../facts/world-state";
import type { WireFrame } from "../render/frame";
import type { Instant } from "../utils/instant";
import type { Field } from "../utils/logfmt";
import type { CheckedRenderRequest } from "./request-context";
import type { AdapterPush, AdapterReply } from "./adapter";
import type { Crosses } from "./crosses";
import type { Lane, LaneFeeds } from "../config/lanes";

// Which request a statusline frame answers: the host's count of the requests
// of every kind it accepted, in arrival order, so renders' ids have gaps.
declare const REQUEST_ID: unique symbol;
export type RequestId = number & { readonly [REQUEST_ID]: true };

// [LAW:one-source-of-truth] Which start of a renderer this is: its
// supervisor's count of starts, from 1. Every id a renderer mints carries it,
// so no id repeats across a restart, and the host tells a dead renderer's id
// by its generation alone.
declare const GENERATION: unique symbol;
export type Generation = number & { readonly [GENERATION]: true };

// An id a renderer minted: its generation, then its count within it.
export type MintedId = `${number}.${number}`;

// [LAW:single-enforcer] The one way a renderer mints an id: each site counts
// its own, under the generation it was built in.
export function minter<Id extends MintedId>(generation: Generation): () => Id {
  let minted = 0;
  // [LAW:types-are-the-program] exception: the brand is what this mints.
  return () => `${generation}.${++minted}` as Id;
}

export const generationOf = (id: MintedId): Generation =>
  Number(id.slice(0, id.indexOf("."))) as Generation;

// An effect's name, minted by the renderer that returned it, which its
// `effect-done` carries back.
declare const EFFECT_ID: unique symbol;
export type EffectId = MintedId & { readonly [EFFECT_ID]: true };

// [LAW:one-type-per-behavior] One interface over every transport: in process,
// and over its own process's stdio. Each kind of input answers with its own
// output, so an input pays only for what it is.
export interface Renderer {
  answer(input: StartInput | EventInput): Promise<RendererOutput>;
  answer(input: AdapterInput): Promise<AdapterOutput>;
}

export type RendererInput = StartInput | EventInput | AdapterInput;

// [LAW:single-enforcer] The one dispatch from an input to the answer of its
// kind, which every renderer is built by. Each arm is typed by its own input
// and output, so an arm answering the other kind's output fails the build,
// which an overload's body does not.
export function rendererOf(arms: {
  readonly start: (input: StartInput) => Promise<RendererOutput>;
  readonly event: (input: EventInput) => Promise<RendererOutput>;
  readonly adapter: (input: AdapterInput) => Promise<AdapterOutput>;
}): Renderer {
  function answer(input: StartInput | EventInput): Promise<RendererOutput>;
  function answer(input: AdapterInput): Promise<AdapterOutput>;
  function answer(
    input: RendererInput,
  ): Promise<RendererOutput | AdapterOutput> {
    switch (input.kind) {
      case "start":
        return arms.start(input);
      case "event":
        return arms.event(input);
      case "adapter":
        return arms.adapter(input);
    }
  }
  return { answer };
}

// [LAW:one-source-of-truth] A renderer's first input, complete: it holds,
// once answered, every session it would hold had it never stopped, but the
// unsaved state its own process kept (open menus, armed confirms).
export interface StartInput {
  readonly kind: "start";
  readonly start: Start;
  readonly at: Instant;
}

export interface Start {
  readonly cause: StartCause;
  readonly sessions: readonly SessionSnapshot[];
}

// Why this renderer started: the first of its name, or the one after a
// renderer that ended, whose end it says in words ("exited with code 1").
export type StartCause =
  | { readonly kind: "first" }
  | { readonly kind: "crashed"; readonly ended: string };

// A session the host holds live: its latest request's context with the world
// state last stamped for it, and whether a feed draws it.
export interface SessionSnapshot {
  readonly context: CheckedRenderRequest;
  readonly worldState: WorldState;
  readonly pinned: boolean;
}

export interface EventInput {
  readonly kind: "event";
  readonly event: Event;
  // [LAW:effects-at-boundaries] The instant the turn runs at, read by the host:
  // the renderer reads no clock for it.
  readonly at: Instant;
}

// [LAW:effects-at-boundaries] exception: a reach of the host's into the
// renderer that is not yet an event, listed in the adapter
// (src/renderer-interface/adapter.ts). A push opens no view and names no
// session's subscriptions, so it carries none of an event's turn: its output
// is its reply alone.
export interface AdapterInput {
  readonly kind: "adapter";
  readonly push: AdapterPush;
  readonly at: Instant;
}

// [LAW:no-silent-failure] A push's turn answers its reply, of its push's own
// kind, or how it threw, as data.
export type AdapterOutput =
  | { readonly kind: "replied"; readonly reply: AdapterReply }
  | { readonly kind: "threw"; readonly failure: Failure };

// [LAW:types-are-the-program] Every input and output of a turn is plain data:
// the build fails on one a process could not carry.
export const INPUTS_CROSS: Crosses<RendererInput> = true;
export const OUTPUTS_CROSS: Crosses<RendererOutput | AdapterOutput> = true;

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
      // How long the request may still wait, in milliseconds from this
      // turn's start, from its client's deadline: a span, which each process
      // counts on its own monotonic clock, so no clock is shared and none
      // stepped moves it. The renderer still waits inside this turn, over the
      // world states the host hands in, until the mailbox moves the wait, so
      // its turns overlap: other inputs, other requests' included, arrive
      // while this one waits.
      readonly waitMs: number;
      // When the idle period of the menus the session's last frame drew
      // began, as the host's idle clock reads it at the request's instant:
      // null while that frame drew none, or a click is in flight.
      readonly idleSince: Instant | null;
      // What the host's feeds know of the session at the request's instant:
      // the lanes that follow it and draw it now, which the statusline hands
      // the bar to, and what each was sent of late, which the bar's rate
      // cell shows.
      readonly following: readonly Lane[];
      readonly feeds: LaneFeeds;
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
      // [LAW:one-source-of-truth] The newest request of the click's session
      // the host holds, whose hints are the pane its lanes follow: null when
      // the click names no session, or the host holds no request of it (none
      // since a restart, or its record evicted).
      readonly latest: CheckedRenderRequest | null;
    }
  | {
      // The session's idle clock ran out: the turn closes its menus as the
      // ✕ does.
      readonly kind: "menu-idle";
      readonly session: SessionId;
      // The firing of the session's idle clock: the close's line says its
      // span, and the close's journal turn names it when it asks the clock
      // whether the session is still idle since.
      readonly idle: IdleSpan;
      // The newest request of the session the host holds, as a click's.
      readonly latest: CheckedRenderRequest | null;
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
  // Read through `parseFrame`: its Infinity crosses as null.
  readonly frame: WireFrame;
}

export type Effect = Present;

// [LAW:nothing-unseen] What a turn learned, in the order it learned it, which
// the host writes beside the input's event.
export type TurnRecord = readonly Field[];

// [LAW:types-are-the-program] A source the renderer's state needs read for
// one session: a plugin source, at its storage folder, named by the variable
// that reads it; or a `shell` or `file` run, named by its digest.
export type Subscription =
  | {
      readonly kind: "plugin";
      readonly source: SourceId;
      readonly folder: string;
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

// How a turn ended, a turn that threw included: its failure as data, a class
// crossing no process. Either way it carries the record it reached.
export type TurnOutcome = { readonly record: TurnRecord } & (
  | { readonly kind: "answered"; readonly effects: readonly Effect[] }
  | { readonly kind: "threw"; readonly failure: Failure }
);

// [LAW:no-silent-failure] Every turn answers, so `answer` never rejects. Its
// output names the open views' subscriptions as they stand after it, however
// it ended: an act can land before its turn throws (a click that committed
// and followed its view), and its view is read all the same.
export type RendererOutput = TurnOutcome & {
  readonly subscriptions: Subscriptions;
};

// A firing of a session's idle timer: when it fired, how long the session was
// idle by then, and the timeout it ran.
export interface IdleSpan {
  readonly firedAt: Instant;
  readonly idleS: number;
  readonly timeoutS: number;
}
