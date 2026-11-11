// A render request answered by its renderer: the host delivers the request,
// performs the effects its turn returned, and answers the client with the one
// frame presented for it, in the encoding the client asked for.

import type { Effect, RequestId } from "../renderer/interface.js";
import type { CheckedRenderRequest } from "../renderer/request-context.js";
import { elapsedMs, type Timekeeper } from "../time.js";
import { instantOf, type Instant } from "../utils/instant.js";
import { RENDER_ANSWERS, renderFailed } from "./draw-bar.js";
import type { Response } from "./protocol";
import type { FrameSeen } from "./render-sightings";
import type { Collector } from "./collector.js";
import type { RendererHost } from "./renderer-host.js";
import {
  noteFacts,
  type RequestFacts,
  type RequestOutcome,
} from "./request-event.js";

export interface StatuslineAnswer {
  readonly outcome: RequestOutcome;
  readonly resp: Response;
  // What the client's sighting records the frame drew as.
  readonly seen: FrameSeen;
  // [LAW:effects-at-boundaries] Told by the connection, once, whether the
  // client took the answer.
  readonly settled: (delivered: boolean) => void;
}

// What the sender of a reply that owes no one anything tells it.
export const NOTHING_TO_SETTLE = (_delivered: boolean): void => {};

// [LAW:no-silent-failure] A request whose turn did not answer it is answered
// with a failure naming the renderer, never with an empty bar. `error` is what
// the request's event records: the thrown value itself, its stack included,
// when the turn threw; the client reads it after the renderer and `doing`.
function failed(
  host: RendererHost,
  error: unknown,
  doing = "",
): StatuslineAnswer {
  const refusal = renderFailed(error);
  return {
    outcome: { kind: "threw", error },
    resp: {
      ...refusal,
      error: `renderer ${host.name}: ${doing}${refusal.error}`,
    },
    seen: "failed",
    settled: NOTHING_TO_SETTLE,
  };
}

export async function answerStatusline(
  host: RendererHost,
  collector: Pick<Collector, "requested">,
  clock: Pick<Timekeeper, "monotonic" | "now">,
  req: CheckedRenderRequest,
  id: RequestId,
  at: Instant,
  waitEndsAt: number,
  facts: RequestFacts,
): Promise<StatuslineAnswer> {
  // [LAW:no-ambient-temporal-coupling] Delivered on arrival, with the world
  // state read at its own keys: nothing waits before delivery, so the renderer
  // takes each session's requests and documents in the order they were made.
  const delivered = await host.deliver(
    {
      kind: "event",
      at,
      event: {
        kind: "request",
        id,
        context: req,
        worldState: collector.requested(req),
        waitEndsAt,
      },
    },
    [],
  );
  if (delivered.kind === "threw") {
    // [LAW:nothing-unseen] What the turn learned before it threw, on the
    // request's own event.
    facts.push(...delivered.record);
    noteFacts(facts, { renderer: host.name });
    return failed(host, delivered.error);
  }
  const { effects, record } = delivered.output;
  // The record leads: it opens with the session, which the event's readers
  // key on (`render sid=`).
  facts.push(...record);
  noteFacts(facts, {
    renderer: host.name,
    effects: effects.map((e) => `${e.kind}:${e.surface}`).join(",") || "-",
  });
  // [LAW:single-enforcer] The one `effect-done` each effect is owed, through
  // the host's one path to the renderer.
  const done = (effect: Effect, reason: string | null): void =>
    void host.deliver(
      {
        kind: "event",
        at: instantOf(new Date(clock.now())),
        event: {
          kind: "effect-done",
          of: effect.id,
          outcome:
            reason === null ? { kind: "ok" } : { kind: "failed", reason },
        },
      },
      [
        ["sid", req.sessionId],
        ["effect", String(effect.id)],
      ],
    );
  // [LAW:types-are-the-program] Every effect the turn returned, in its order,
  // is performed or refused: the first statusline frame for this request
  // answers it, and nothing else may.
  let answer: Effect | null = null;
  for (const effect of effects) {
    switch (effect.kind) {
      case "present":
        if (effect.request !== id)
          done(
            effect,
            `presents request ${effect.request}, not this turn's ${id}`,
          );
        else if (answer !== null)
          done(effect, `a second statusline frame for request ${id}`);
        else answer = effect;
        break;
    }
  }
  if (answer === null)
    return failed(
      host,
      new Error(`presented no statusline frame for request ${id}`),
    );
  const presented = answer;
  const encodeFrom = clock.monotonic();
  let resp: Response;
  try {
    resp = RENDER_ANSWERS[req.encoding](presented.frame);
  } catch (e) {
    done(presented, `encoding its frame threw: ${renderFailed(e).error}`);
    return failed(host, e, "its frame could not be encoded: ");
  }
  // [LAW:nothing-unseen] The bytes' share of the draw's reserve, beside the
  // renderer's `drew=`.
  noteFacts(facts, { encoded: `${elapsedMs(clock, encodeFrom)}ms` });
  return {
    outcome: { kind: "ok" },
    resp,
    seen: presented.frame.motion,
    settled: (took) =>
      done(presented, took ? null : "the client did not take the answer"),
  };
}
