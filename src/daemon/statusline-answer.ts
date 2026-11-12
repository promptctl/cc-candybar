// A render request answered by its renderer: the host delivers the session's
// config and then the request, performs the effects the request's turn
// returned, and answers the client with the one frame presented for it, in the
// encoding the client asked for.

import path from "node:path";
import type { Effect, RequestId } from "../renderer/interface.js";
import type { CheckedRenderRequest } from "../renderer/request-context.js";
import { elapsedMs, type Timekeeper } from "../time.js";
import { checkoutLocation } from "../utils/git-root.js";
import { instantAt, type Instant } from "../utils/instant.js";
import { RENDER_ANSWERS, renderFailed } from "./draw-bar.js";
import type { Response } from "./protocol";
import type { FrameSeen } from "./render-sightings";
import type { Collector } from "./collector.js";
import type { Delivered, RendererHost } from "./renderer-host.js";
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

// [LAW:effects-at-boundaries] The request's context as both its turns take
// it: the checkout its directory is in, read from the disk by the host, so
// the renderer reads no file for it and the two turns read one location.
function located(req: CheckedRenderRequest): CheckedRenderRequest {
  const dir = req.hookData.workspace?.current_dir ?? req.cwd;
  return {
    ...req,
    hookData: {
      ...req.hookData,
      ...(dir !== undefined &&
        path.isAbsolute(dir) && { location: checkoutLocation(dir) }),
    },
  };
}

// [LAW:nothing-unseen] What a turn the request's answer took learned, on the
// request's own event.
function recorded(facts: RequestFacts, delivered: Delivered): void {
  facts.push(
    ...(delivered.kind === "answered"
      ? delivered.output.record
      : delivered.record),
  );
}

export async function answerStatusline(
  host: RendererHost,
  collector: Pick<Collector, "requested">,
  clock: Pick<Timekeeper, "monotonic" | "now">,
  arrived: CheckedRenderRequest,
  id: RequestId,
  at: Instant,
  waitEndsAt: number,
  facts: RequestFacts,
): Promise<StatuslineAnswer> {
  const req = located(arrived);
  // [LAW:single-enforcer] The one `effect-done` each effect is owed, through
  // the host's one path to the renderer.
  const done = (effect: Effect, reason: string | null): void =>
    void host.deliver(
      {
        kind: "event",
        at: instantAt(clock),
        event: {
          kind: "effect-done",
          of: effect.id,
          outcome:
            reason === null ? { kind: "ok" } : { kind: "failed", reason },
        },
      },
      [
        ["sid", req.hookData.session_id],
        ["effect", String(effect.id)],
      ],
    );
  // [LAW:no-ambient-temporal-coupling] The host owns the order: the session's
  // config goes first, with the world state read at the request's keys, and
  // its output's subscriptions reach the collector as the turn answers. A set
  // that moved is declared and its stamp handed in before the request is
  // delivered, so the request's wait covers every source the view reads.
  // In process the config turn answers at once, so nothing that opens or
  // closes a view runs between it and the request; out of process, the
  // router's mailbox is what keeps the two adjacent.
  const configured = await host.answer({
    kind: "event",
    at,
    event: {
      kind: "config",
      context: req,
      worldState: collector.requested(req),
    },
  });
  // [LAW:nothing-unseen] The config turn's record leads: it opens with the
  // session, which the event's readers key on (`render sid=`), and says what
  // the context was, whether or not a request turn runs after it.
  recorded(facts, configured);
  if (configured.kind === "threw") {
    noteFacts(facts, { renderer: host.name });
    return failed(host, configured.error, "its config turn: ");
  }
  const delivered = await host.answer({
    kind: "event",
    at,
    event: { kind: "request", id, context: req, waitEndsAt },
  });
  recorded(facts, delivered);
  if (delivered.kind === "threw") {
    noteFacts(facts, { renderer: host.name });
    return failed(host, delivered.error);
  }
  const { effects } = delivered.output;
  noteFacts(facts, {
    renderer: host.name,
    effects: effects.map((e) => `${e.kind}:${e.surface}`).join(",") || "-",
  });
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
