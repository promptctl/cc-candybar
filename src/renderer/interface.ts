// The renderer interface (docs/design/host-and-renderer.md §7): the host hands
// a renderer inputs, and the renderer answers each with the effects it asks
// the host to perform and the record of its turn.
//
// [LAW:one-way-deps] The host depends on this module and the renderer
// implements it; it imports only types, the vocabulary both sides speak: the
// session context, the frame, the instant.
// [LAW:types-are-the-program] The unions hold only the arms something produces
// and something consumes; each later step adds its own.

import type { SessionId } from "../daemon/session-id";
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
      readonly kind: "request";
      readonly id: RequestId;
      readonly context: CheckedRenderRequest;
      // The monotonic moment the request's wait ends, from its client's
      // deadline: the renderer still waits inside this turn until the wait
      // moves onto its world state, so its turns overlap: other inputs, other
      // requests' included, arrive while this one waits.
      readonly waitEndsAt: number;
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

export interface RendererOutput {
  readonly effects: readonly Effect[];
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
