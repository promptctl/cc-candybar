// A render request answered by its renderer: the host delivers the session's
// context, waits on its world state, then delivers the request, performs the
// effects the request's turn returned, and answers the client with the one
// frame presented for it, in the encoding the client asked for.

import path from "node:path";
import type {
  DrawInspection,
  Effect,
  Event,
  Present,
  RequestId,
  TurnOutcome,
} from "../renderer-interface/interface.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import { inspect } from "node:util";
import { elapsedMs, type Timekeeper } from "../time.js";
import { waitWithin } from "../utils/reading.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { CheckoutLocation } from "../utils/git-root.js";
import {
  failedWith,
  RENDER_ANSWERS,
  renderFailure,
} from "./foundations/render-answers.js";
import {
  DaemonClosing,
  failureOf,
  type Failure,
} from "./foundations/verb-error.js";
import type { Response } from "./foundations/protocol";
import type { PublishFrame } from "./foundations/frame-publication.js";
import type { FrameSeen } from "./foundations/sightings";
import type { Collector } from "./collector.js";
import type { SessionEnvironment } from "./foundations/session-env.js";
import type { HostTurn, Made, RendererHost } from "./renderer-host.js";
import {
  noteFacts,
  type RequestFacts,
  type RequestOutcome,
} from "./foundations/request-event.js";

export interface StatuslineAnswer {
  readonly outcome: RequestOutcome;
  readonly resp: Response;
  readonly inspection?: DrawInspection;
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
// the request's event records: the failure's detail, an Error's stack
// included; the client reads its message after the renderer and `doing`.
function failed(
  host: RendererHost,
  failure: Failure,
  doing = "",
): StatuslineAnswer {
  return {
    outcome: renderFailure(failure),
    resp: failedWith(`renderer ${host.name}: ${doing}${failure.message}`),
    seen: "failed",
    settled: NOTHING_TO_SETTLE,
  };
}

// Where a directory sits in its repository: the disk's answer for a session
// on this machine, a fixture's for a faked one.
export type Locate = (dir: string) => CheckoutLocation;

// [LAW:effects-at-boundaries] The request's context as both its turns take
// it: the checkout its directory is in, read by the host, so the renderer
// reads no file for it and the two turns read one location.
export function located(
  req: CheckedRenderRequest,
  locate: Locate,
): CheckedRenderRequest {
  const dir = req.hookData.workspace?.current_dir ?? req.cwd;
  return {
    ...req,
    hookData: {
      ...req.hookData,
      ...(dir !== undefined &&
        path.isAbsolute(dir) && { location: locate(dir) }),
    },
  };
}

// A turn's time, or `-` for a turn no renderer answered.
const msOf = (ms: number | null): string => (ms === null ? "-" : `${ms}ms`);

// [LAW:nothing-unseen] What a turn the request's answer took learned, on the
// request's own event.
function recorded(facts: RequestFacts, delivered: TurnOutcome): void {
  facts.push(...delivered.record);
}

export async function answerStatusline(
  host: RendererHost,
  publish: PublishFrame,
  collector: Pick<Collector, "requested" | "holding" | "settled">,
  clock: Pick<Timekeeper, "monotonic" | "now" | "after">,
  // The daemon's close, which ends the request's wait.
  closing: AbortSignal,
  log: DaemonLogger,
  locate: Locate,
  arrived: CheckedRenderRequest,
  environment: SessionEnvironment,
  id: RequestId,
  // The monotonic moment the request's wait ends, the host's own reading.
  waitEndsAt: number,
  facts: RequestFacts,
  inspectDraw?: true,
): Promise<StatuslineAnswer> {
  const req = located(arrived, locate);
  const session = req.hookData.session_id;
  // [LAW:single-enforcer] The one `effect-done` each effect is owed, through
  // the host's one path to the renderer.
  const done = (effect: Effect, reason: string | null): void =>
    void host.deliver(
      () => ({
        kind: "event",
        event: {
          kind: "effect-done",
          session: effect.session,
          of: effect.id,
          outcome:
            reason === null ? { kind: "ok" } : { kind: "failed", reason },
        },
      }),
      [["effect", String(effect.id)]],
    );
  // [LAW:single-enforcer] Each of the request's turns is made as its slot
  // comes, and none once the daemon's close has begun: the teardown is
  // closing the views it would open or draw into.
  const unlessClosing = (event: Event) => (): Made =>
    closing.aborted
      ? failureOf(new DaemonClosing("render"))
      : { kind: "event", event };
  const worldState = collector.requested(req, environment);
  // [LAW:no-ambient-temporal-coupling] The request holds its session from its
  // context to its answer, wait included, so no sweep retires it between.
  const release = collector.holding(session);
  let configured: HostTurn;
  let delivered: HostTurn;
  try {
    // [LAW:no-ambient-temporal-coupling] The host owns the order: the
    // session's context goes first, with the world state read at the
    // request's keys, and its output's subscriptions reach the collector as
    // the turn answers, so the wait covers every run the view names. The
    // wait is the host's, between the two turns, and holds no place in the
    // mailbox: another input's turn that lands meanwhile, one that evicts
    // the session's view included, moves what the wait covers.
    configured = await host.answer(
      unlessClosing({ kind: "context", context: req, worldState }),
    );
    // [LAW:nothing-unseen] The context turn's record leads: it opens with the
    // session, which the event's readers key on (`render sid=`), and says
    // what the context was, whether or not a request turn runs after it.
    recorded(facts, configured);
    if (configured.kind === "threw") {
      noteFacts(facts, { renderer: host.name });
      return failed(host, configured.failure, "its context turn: ");
    }
    // Rules 1 and 2 of the model: the answer shows what this request
    // carried, so it waits for the first value of every fact of its world
    // state it waits on, until its client's deadline. A warm session's world
    // state is current already, so its request is delivered at once. What
    // has not answered by then draws as pending, and lands for the next
    // frame.
    const waitFrom = clock.monotonic();
    const budget = waitEndsAt - waitFrom;
    noteFacts(facts, {
      deadline: `${req.deadline.kind}:${Math.round(budget)}ms`,
    });
    const ended = await waitWithin(
      (signal) => collector.settled(session, signal),
      budget,
      // [LAW:no-silent-failure] The answer is drawn; a wait that fails after
      // it is a bug, said against the session, never one that ends the
      // daemon.
      (e, how) =>
        log(
          "error",
          `render wait failed after it ended ended=${how} sid=${JSON.stringify(session)}: ${inspect(e)}`,
        ),
      clock.after,
      closing,
    );
    // [LAW:nothing-unseen] How the wait went, on the render event: an answer
    // drawn with values pending says so by name.
    noteFacts(facts, { waited: `${elapsedMs(clock, waitFrom)}ms`, ended });
    // [LAW:no-ambient-temporal-coupling] Its readings are made as its turn
    // comes, so it draws the instant it is drawn at, after every input
    // ahead of it: a click that landed during the wait included.
    delivered = await host.answer(
      unlessClosing({
        kind: "request",
        id,
        context: req,
        ...(inspectDraw === true ? { inspect: true } : {}),
      }),
    );
  } finally {
    release();
  }
  recorded(facts, delivered);
  // [LAW:nothing-unseen] Both turns' times in the renderer, their waits in
  // the mailbox and their hops, beside `took`: what the renderer and reaching
  // it cost this request. `drew=` is what the draw's reserve is held to
  // (DRAW_RESERVE_MS), with `encoded=` for its bytes.
  noteFacts(facts, {
    configured: msOf(configured.turnMs),
    drew: msOf(delivered.turnMs),
    mailbox: `${configured.queuedMs + delivered.queuedMs}ms`,
    hop:
      configured.hopMs === null || delivered.hopMs === null
        ? "-"
        : `${configured.hopMs + delivered.hopMs}ms`,
  });
  const { effects } = delivered;
  noteFacts(facts, {
    renderer: host.name,
    effects:
      effects
        .map((e) => (e.kind === "present" ? `present:${e.surface}` : e.kind))
        .join(",") || "-",
  });
  // [LAW:types-are-the-program] Every present the turn returned, in its
  // order, is performed or refused: the first statusline frame for this
  // request answers it, and nothing else may; a turn that threw answers
  // nothing. A change was the host's to perform as the turn answered.
  let answer: Present | null = null;
  for (const effect of effects) {
    switch (effect.kind) {
      case "present":
        if (delivered.kind === "threw") done(effect, "its turn threw");
        else if (effect.request !== id)
          done(
            effect,
            `presents request ${effect.request}, not this turn's ${id}`,
          );
        else if (effect.session !== session)
          done(
            effect,
            `presents session ${JSON.stringify(effect.session)}, not this request's ${JSON.stringify(session)}`,
          );
        else if (answer !== null)
          done(effect, `a second statusline frame for request ${id}`);
        else answer = effect;
        break;
      case "change":
        break;
    }
  }
  if (delivered.kind === "threw") return failed(host, delivered.failure);
  if (answer === null)
    return failed(
      host,
      failureOf(new Error(`presented no statusline frame for request ${id}`)),
    );
  const presented = answer;
  const encodeFrom = clock.monotonic();
  let resp: Response;
  try {
    resp = RENDER_ANSWERS[req.encoding](publish(presented.frame));
  } catch (e) {
    const failure = failureOf(e);
    done(presented, `encoding its frame threw: ${failure.message}`);
    return failed(host, failure, "its frame could not be encoded: ");
  }
  // [LAW:nothing-unseen] The bytes' share of the draw's reserve, beside
  // `drew=`.
  noteFacts(facts, { encoded: `${elapsedMs(clock, encodeFrom)}ms` });
  return {
    outcome: { kind: "ok" },
    resp,
    seen: presented.frame.motion,
    ...(presented.inspection === undefined
      ? {}
      : { inspection: presented.inspection }),
    settled: (took) =>
      done(presented, took ? null : "the client did not take the answer"),
  };
}
