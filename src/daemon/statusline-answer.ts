// A render request answered by its renderer: the host delivers the session's
// context, waits on its world state, then delivers the request, performs the
// effects the request's turn returned, and answers the client with the one
// frame presented for it, in the encoding the client asked for.

import type {
  Notification,
  Present,
  RequestId,
  TurnOutcome,
} from "../renderer-interface/interface.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import { elapsedMs, type Timekeeper } from "../time.js";
import { waitWithin } from "../utils/reading.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { CheckoutLocation } from "../utils/git-root.js";
import type { Outcome } from "../utils/outcome.js";
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
import { timeoutResponse } from "./foundations/request-deadline.js";
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
  // What the client's sighting records the frame drew as.
  readonly seen: FrameSeen;
  // [LAW:effects-at-boundaries] Told by the connection, once, whether the
  // client took the answer.
  readonly settled: (delivered: boolean) => void;
}

// What the sender of a reply that owes no one anything tells it.
export const NOTHING_TO_SETTLE = (_delivered: boolean): void => {};

// [LAW:types-are-the-program] No draw was sent, so there is no presentation
// to settle. Its request still records an abandoned outcome.
const DRAW_ABANDONED: Failure = {
  kind: "abandoned",
  message: "the statusline reply has no recipient",
  detail: "the statusline reply has no recipient",
};

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
export type Locate = (dir: string) => Outcome<CheckoutLocation>;

const NO_REPOSITORY: CheckoutLocation = {
  main: "",
  worktree: "",
  subpath: "",
  noRepo: true,
};

// [LAW:effects-at-boundaries] The request's context as both its turns take
// it: the checkout its directory is in, read by the host, so the renderer
// reads no file for it and the two turns read one location.
function located(
  req: CheckedRenderRequest,
  locate: Locate,
): { readonly req: CheckedRenderRequest; readonly error: string | null } {
  const found = locate(req.hookData.workspace.current_dir);
  return {
    error: found.kind === "failed" ? found.reason : null,
    req: {
      ...req,
      hookData: {
        ...req.hookData,
        location:
          found.kind === "ok"
            ? found.value
            : found.kind === "absent"
              ? NO_REPOSITORY
              : undefined,
      },
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
  collector: Pick<
    Collector<CheckedRenderRequest>,
    "requested" | "holding" | "settled" | "holds"
  >,
  clock: Pick<Timekeeper, "monotonic" | "now" | "after" | "failed">,
  // The daemon's close, which ends the request's wait.
  closing: AbortSignal,
  log: DaemonLogger,
  locate: Locate,
  arrived: CheckedRenderRequest,
  environment: SessionEnvironment,
  id: RequestId,
  recipient: {
    readonly waitEndsAt: number;
    readonly gone: () => boolean;
  },
  facts: RequestFacts,
): Promise<StatuslineAnswer> {
  const { req, error: checkoutError } = located(arrived, locate);
  const session = req.hookData.session_id;
  // [LAW:single-enforcer] Each of the request's turns is made as its slot
  // comes, and none once the daemon's close has begun: the teardown is
  // closing the views it would open or draw into.
  const unlessClosing = (event: Notification) => (): Made =>
    closing.aborted
      ? failureOf(new DaemonClosing("render"))
      : { kind: "event", event };
  const abandoned = (): boolean => !closing.aborted && recipient.gone();
  const worldState = collector.requested(req, environment);
  // [LAW:no-ambient-temporal-coupling] The request holds its session from its
  // context to its answer, wait included, so no sweep retires it between.
  const release = collector.holding(session);
  let configured: HostTurn;
  let delivered: HostTurn | null = null;
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
    // [LAW:no-silent-failure] A failed lookup leaves the location unknown.
    // The request says why, and the bar does not offer to initialize Git.
    if (checkoutError !== null) noteFacts(facts, { checkoutError });
    if (configured.kind === "threw") {
      noteFacts(facts, { renderer: host.name });
      return failed(host, configured.failure, "its context turn: ");
    }
    // [LAW:single-enforcer] The context's matching config turn is part of
    // readiness. Its failure ends this request before the collector wait.
    if (configured.configFailure !== undefined) {
      noteFacts(facts, { renderer: host.name });
      return failed(host, configured.configFailure, "its config turn: ");
    }
    // [LAW:effects-at-boundaries] The context still serves the shared
    // session, including panes. Only the source wait and one-off draw
    // belong to the connection that asked for the reply.
    if (!abandoned()) {
      const waitFrom = clock.monotonic();
      const budget = recipient.waitEndsAt - waitFrom;
      noteFacts(facts, {
        deadline: `${req.deadline.kind}:${Math.round(budget)}ms`,
      });
      const ended = await waitWithin(
        `render wait ${session}`,
        (signal) => collector.settled(session, signal),
        budget,
        clock,
        closing,
      );
      // [LAW:nothing-unseen] What the wait still held on when it ended: `-`
      // when it had let go, else the renderer's turn and the unread facts.
      const held = collector.holds(session);
      noteFacts(facts, {
        waited: `${elapsedMs(clock, waitFrom)}ms`,
        ended,
        held: held.length === 0 ? "-" : held.join(","),
      });

      // [LAW:no-ambient-temporal-coupling] Admit the draw only while the
      // reply has a recipient. A closure or deadline can land while the
      // source wait or the mailbox is serving something else.
      if (!abandoned()) {
        const draw = unlessClosing({ kind: "request", id, context: req });
        delivered = await host.answer(() =>
          abandoned() ? DRAW_ABANDONED : draw(),
        );
      }
    }
  } finally {
    release();
  }
  if (delivered !== null) recorded(facts, delivered);
  // [LAW:nothing-unseen] Both turns' times in the renderer, their waits in
  // the mailbox and their hops, beside `took`: what the renderer and reaching
  // it cost this request. `drew=` is what the draw's reserve is held to
  // (DRAW_RESERVE_MS), with `encoded=` for its bytes.
  const drawHop = delivered === null ? 0 : delivered.hopMs;
  noteFacts(facts, {
    configured: msOf(configured.turnMs),
    drew: msOf(delivered?.turnMs ?? null),
    mailbox: `${configured.queuedMs + (delivered?.queuedMs ?? 0)}ms`,
    hop:
      configured.hopMs === null || drawHop === null
        ? "-"
        : `${configured.hopMs + drawHop}ms`,
    renderer: host.name,
  });
  if (
    delivered === null ||
    (delivered.kind === "threw" && delivered.failure === DRAW_ABANDONED)
  )
    return {
      outcome: DRAW_ABANDONED,
      resp: timeoutResponse(id, DRAW_ABANDONED.message),
      seen: "failed",
      settled: NOTHING_TO_SETTLE,
    };
  const done = delivered.settlePresentation;
  const { effects } = delivered;
  noteFacts(facts, {
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
    // [LAW:one-source-of-truth] The mailbox that presented this frame is
    // the authority on its publisher, independent of later session moves.
    resp = RENDER_ANSWERS[req.encoding](
      publish(presented.frame, { renderer: host.name, session }),
    );
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
    settled: (took) =>
      done(presented, took ? null : "the client did not take the answer"),
  };
}
