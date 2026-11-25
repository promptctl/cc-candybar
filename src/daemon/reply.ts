// A daemon's answer to a request: the checkpoint, then a reply per kind.

import { inspect } from "node:util";
import type { DaemonParts } from "./daemon-parts.js";
import { cacheTallyFacts } from "./readings.js";
import {
  failedWith,
  framedResponse,
  renderFailure,
} from "./foundations/render-answers.js";
import {
  answerStatusline,
  NOTHING_TO_SETTLE,
  type StatuslineAnswer,
} from "./statusline-answer.js";
import { checkRenderRequest } from "./render-checkpoint.js";
import type {
  DesktopAct,
  EffectOutcome,
} from "../renderer-interface/interface.js";
import { type CheckedRenderRequest } from "../renderer-interface/request-context.js";
import {
  PROTOCOL_VERSION,
  SESSION_RENDER_KIND,
  ENVIRONMENT_NEEDED,
  UNKNOWN_REQUEST_KIND,
  URL_FRAME_VERSIONS,
  awaitsVerdict,
  ACTS_ON_DESKTOP,
  type Inbound,
  type OwnerFacts,
  type Request,
  type Response,
  type SubscribeRequest,
} from "./foundations/protocol";
import { parseDelivered } from "../click/gesture.js";
import type { PaneOwner } from "./frame-feed.js";
import type { Asked } from "../utils/outcome.js";
import { parseSessionId, type SessionId } from "./foundations/session-id";
import type {
  MailboxStats,
  RendererMemoryPanel,
  RendererPanel,
  SourceSnapshots,
} from "./foundations/stats-snapshot";
import type { RendererProcessState } from "./renderer-process.js";
import { type LinkSigner } from "../click/link-signer.js";
import { parseClick, type ReadClick } from "./click-reading.js";
import type { RendererName } from "./foundations/renderer-name.js";
import type { RendererHost } from "./renderer-host.js";
import {
  badRequest,
  ClickAbandoned,
  DaemonClosing,
  failureOf,
  RendererDown,
  type Failure,
} from "./foundations/verb-error";
import { elapsedMs, spanMs } from "../time.js";
import { waitWithin } from "../utils/reading.js";
import { transcriptReads } from "../utils/transcript-fs.js";
import {
  ACTS_ON_DAEMON,
  type ActsOn,
  type ClickArrival,
} from "../renderer-interface/click-arrival";
import { transcriptSaid } from "./render-sightings";
import { type FrameSeen } from "./foundations/sightings";
import { claudeConfigDir } from "../claude-settings";
import { DEBUG_WHATS, isDebugWhat } from "./foundations/debug-types";
import { recordingCommandOf } from "./foundations/recording-command.js";
import { LANE_NAMES, parseLane, type Lane } from "../config/lanes.js";
import { instantAt, instantOf } from "../utils/instant.js";
import {
  renderDeadlines,
  REQUEST_TIMEOUT_MS,
} from "./foundations/request-deadline.js";
import type { RendererStats } from "../renderer-interface/renderer-stats.js";
import {
  noteFacts,
  requestEvent,
  type Acceptance,
  type RequestFacts,
  type RequestOutcome,
} from "./foundations/request-event.js";

// A click as its connection knows it: whether its client has left.
interface ClickInFlight {
  readonly gone: () => boolean;
}

// [LAW:no-ambient-temporal-coupling] A request whose semantics include "then
// exit" (the shutdown verb) must not exit
// until its response has flushed — but handleRequest cannot see the socket.
// So the exit is returned as DATA (the exit code; null = stay up) and the
// connection boundary, which owns the flush, sequences shutdown on the write
// completion. No timer stands between respond and exit.
// [LAW:effects-at-boundaries] handleRequest computes the description; the
// socket boundary performs it.
export interface Reply {
  // [LAW:single-enforcer] The response as its client is sent it, framed once
  // where the reply is made (`replyOf`): one too big to send is RENDER_FAILED
  // here, with why it was `unsent`, so whoever records the request records
  // what its client got.
  readonly resp: Response;
  readonly frame: Buffer;
  readonly unsent: Error | null;
  readonly exitAfterFlush: number | null;
  // [LAW:effects-at-boundaries] Told by the reply's sender, once, whether the
  // client took the response — only the connection knows: a render's answer
  // is a present its renderer is owed an `effect-done` for.
  readonly settled: (delivered: boolean) => void;
}
// A subscription is the one request answered by a stream rather than a reply:
// the connection boundary turns its socket over to the session's feed. The URL
// handler's frame is answered by its verdict, whether its link opened, as soon
// as it is read, and its click lands after: the app tells a refusal at once,
// and a slow click that lands is never told as failed.
export type HandledRequest =
  | ({ kind: "reply" } & Reply)
  | {
      kind: "subscribe";
      sessionId: SessionId;
      lane: Lane;
      // Set when the subscriber is the pane that owns the session's pointer.
      owner: PaneOwner | null;
    }
  | {
      kind: "url";
      told: Told;
      // [LAW:no-ambient-temporal-coupling] The click, started by whoever
      // wrote the verdict once it is written, so no work of the click's
      // stands before it. Settles once the click's event is written, with
      // what the click came to: the verdict of a writer told `landed`.
      land: () => Promise<Reply>;
    };

// [LAW:types-are-the-program] When a url frame's writer reads its verdict: never
// (a version 1 writer hangs up at once, so its verdict goes to no one); at
// once, before its click runs, whether its link opened; or once its click has
// landed, for a writer that carries out the click's copy and open itself,
// because those acts are what the click produced.
export type Told =
  | { readonly when: "never" }
  | { readonly when: "at-once"; readonly verdict: Response }
  | { readonly when: "landed" };

// [LAW:dataflow-not-control-flow] A writer that reads no verdict is told none;
// one that reads it is told `verdict` at once, unless it carries out the
// click's acts, which `readUrlFrame` tells once they exist.
function toldAtOnce(urlV: unknown, verdict: Response): Told {
  return awaitsVerdict(urlV) ? { when: "at-once", verdict } : { when: "never" };
}

// The one way a reply is made.
export function replyOf(
  resp: Response,
  exitAfterFlush: number | null = null,
  settled: (delivered: boolean) => void = NOTHING_TO_SETTLE,
): Reply {
  const { sent, frame, unsent } = framedResponse(resp);
  return { resp: sent, frame, unsent, exitAfterFlush, settled };
}

const stay = (resp: Response): Reply => replyOf(resp);

// [LAW:single-enforcer] A render's reply and the outcome its event and the
// stats record, from the one framing, so the record is the answer its client
// is sent: a render too big to send is a failure in the daemon's own record
// as it is to its client.
export function renderRecord(rendered: {
  readonly outcome: RequestOutcome;
  readonly resp: Response;
  readonly settled: (delivered: boolean) => void;
}): { readonly reply: Reply; readonly outcome: RequestOutcome } {
  const reply = replyOf(rendered.resp, null, rendered.settled);
  return {
    reply,
    outcome:
      reply.unsent === null
        ? rendered.outcome
        : renderFailure(failureOf(reply.unsent)),
  };
}
const replied = (reply: Reply): HandledRequest => ({ kind: "reply", ...reply });

// [LAW:no-silent-failure] A late request gets a normal verdict without opening
// a world document or taking a renderer turn. Ingress preserves the close as
// its render or click outcome even when there is no renderer left to record it.
function closingResponse(
  parts: DaemonParts,
  rawKind: unknown,
  accepted: Acceptance,
): Response {
  const kind = eventOf(rawKind);
  const failure = failureOf(new DaemonClosing(kind));
  if (kind === "render" || kind === "click") {
    if (kind === "render") {
      parts.stats.requestsTotal++;
      parts.stats.requestsErrored++;
    }
    const event = requestEvent(
      kind,
      [["req", String(accepted.id)]],
      failure,
      elapsedMs(parts.clock, accepted.at),
    );
    parts.log(event.level, event.line);
  }
  return failedWith(failure.message);
}

export function refuseClosingReply(
  parts: DaemonParts,
  kind: unknown,
  accepted: Acceptance,
): Reply {
  return stay(closingResponse(parts, kind, accepted));
}

export function refuseClosingInbound(
  parts: DaemonParts,
  inbound: Inbound,
  accepted: Acceptance,
): HandledRequest {
  if (inbound.kind !== "url")
    return replied(refuseClosingReply(parts, inbound.req?.kind, accepted));
  const verdict = closingResponse(parts, "click", accepted);
  return {
    kind: "url",
    told: toldAtOnce(inbound.frame.urlV, verdict),
    land: async () => replyOf(verdict),
  };
}

// [LAW:types-are-the-program] Every request kind answered with a reply: all
// but a subscribe, the compiler naming one added to the protocol until it is,
// and the event its outcome is written as.
export type ReplyRequest = Exclude<Request, SubscribeRequest>;
const REPLY_EVENTS: Readonly<
  Record<ReplyRequest["kind"], "render" | "click" | "request">
> = {
  recording: "request",
  render: "render",
  [SESSION_RENDER_KIND]: "render",
  "pane-session": "request",
  pointer: "request",
  shutdown: "request",
  stats: "request",
  click: "click",
  debug: "request",
};

// The kind is untrusted JSON, and one no reply is for leaves no event of its own.
const eventOf = (kind: unknown): "render" | "click" | "request" =>
  typeof kind === "string" && Object.hasOwn(REPLY_EVENTS, kind)
    ? REPLY_EVENTS[kind as ReplyRequest["kind"]]
    : "request";

// [LAW:single-enforcer] The checkpoint's one refusal: the request is
// answered, never streamed, and the connection stays up.
const refusal = (code: "BAD_REQUEST" | "VERSION_MISMATCH", error: string) =>
  stay({ ok: false, error, code, daemonV: PROTOCOL_VERSION });
const refuse = (
  code: "BAD_REQUEST" | "VERSION_MISMATCH",
  error: string,
): HandledRequest => replied(refusal(code, error));

// [LAW:parse-dont-validate] A pane's report of its pointer, read once into
// what the feed holds. The report is untrusted JSON: the id names the pane, the
// gestures are what it delivers, and `hover` is the action under the pointer
// or null.
function parseOwner(raw: unknown): Asked<PaneOwner> {
  const bad = (reason: string): Asked<PaneOwner> => ({
    kind: "failed",
    reason,
  });
  if (typeof raw !== "object" || raw === null)
    return bad("owner is an object of id, gestures and hover");
  const { id, gestures, hover } = raw as Partial<
    Record<keyof OwnerFacts, unknown>
  >;
  if (typeof id !== "string" || id === "")
    return bad("owner.id is a non-empty string");
  if (!Array.isArray(gestures))
    return bad("owner.gestures is a list of the gestures delivered");
  if (hover !== null && typeof hover !== "string")
    return bad("owner.hover is the hovered action's name, or null");
  const delivered = parseDelivered(gestures);
  if (delivered.kind !== "ok")
    return bad(`owner.gestures: ${delivered.reason}`);
  return {
    kind: "ok",
    value: { id, pointer: { gestures: delivered.value, hover } },
  };
}

// A subscribe past the connection's checkpoint: the subscription it opens, or
// the reply refusing it.
// [LAW:parse-dont-validate] Trust boundary: the session id and the lane are
// untrusted JSON; the id keys the feed and the lane is what its toggle gates.
function subscription(req: SubscribeRequest): HandledRequest {
  const sessionId = parseSessionId(req.sessionId);
  if (!sessionId.ok)
    return refuse("BAD_REQUEST", `subscribe's sessionId ${sessionId.problem}`);
  // A subscribe that names no lane speaks the contract from before the
  // lane toggles: VERSION_MISMATCH, which every older client reads as "this
  // client is out of date" and stops on, rather than BAD_REQUEST, which it
  // reads as a daemon too old to take subscribe and retries forever.
  if (req.lane === undefined)
    return refuse(
      "VERSION_MISMATCH",
      `this client's subscribe names no lane (${LANE_NAMES.join(", ")}): it predates the lane toggles — update it`,
    );
  const lane = parseLane(req.lane);
  if (lane === null)
    return refuse(
      "BAD_REQUEST",
      `subscribe needs a lane, one of ${LANE_NAMES.join(", ")}: got ${JSON.stringify(req.lane)}`,
    );
  if (req.owner === undefined)
    return { kind: "subscribe", sessionId: sessionId.id, lane, owner: null };
  // Only the pane lane has a pointer to own.
  if (lane !== "pane")
    return refuse(
      "BAD_REQUEST",
      `only the pane lane has an owner: got ${lane}`,
    );
  const owner = parseOwner(req.owner);
  if (owner.kind !== "ok")
    return refuse("BAD_REQUEST", `subscribe's ${owner.reason}`);
  return {
    kind: "subscribe",
    sessionId: sessionId.id,
    lane,
    owner: owner.value,
  };
}

export async function handleRequest(
  parts: DaemonParts,
  inbound: Inbound,
  timedOut: () => boolean,
  accepted: Acceptance,
  clientLeft: () => boolean,
): Promise<HandledRequest> {
  // The connection classified the frame (classifyInbound): the URL handler's,
  // which carries its own version and is judged by the click path (every one
  // of them writes a click event, refused ones included), or a request, which
  // the `v` gate below admits.
  if (inbound.kind === "url")
    return urlClick(parts, inbound.frame, timedOut, accepted, clientLeft);
  const req = inbound.req;
  if (
    !req ||
    typeof req !== "object" ||
    typeof (req as Request).v !== "number"
  ) {
    return refuse("BAD_REQUEST", "malformed request");
  }

  if (req.v !== PROTOCOL_VERSION) {
    // [LAW:one-source-of-truth] A mismatch in either direction stays up and
    // answers VERSION_MISMATCH, which the client surfaces without kicking.
    // The host changes bundle only when the install's record or the running
    // bundle moves (the binary watch), never because a client claims a newer
    // protocol: a worktree's client ahead of the installed bundle would end the
    // installed host on every respawn, and every bar would flap.
    // A host that ended on a client's claim would be respawned from the same
    // recorded bundle into the same mismatch, once per request.
    parts.log(
      "info",
      `version mismatch: client=${req.v} ${req.v > PROTOCOL_VERSION ? ">" : "<"} daemon=${PROTOCOL_VERSION}; staying up`,
    );
    return replied(
      stay({
        ok: false,
        error: `protocol v${req.v} not supported (daemon at v${PROTOCOL_VERSION})`,
        code: "VERSION_MISMATCH",
        daemonV: PROTOCOL_VERSION,
      }),
    );
  }

  if (req.kind === "subscribe") return subscription(req);
  // [LAW:parse-dont-validate] The kind is untrusted JSON: one no request
  // carries — a name no kind has, or no name at all, which `Object.hasOwn`
  // would coerce into one — is refused here, so replyTo is total over the
  // kinds it is typed for.
  if (typeof req.kind !== "string" || !Object.hasOwn(REPLY_EVENTS, req.kind))
    return refuse("BAD_REQUEST", UNKNOWN_REQUEST_KIND);
  return replied(await replyTo(parts, req, timedOut, accepted, clientLeft));
}

// The reply to a request of any kind but a subscribe, past the connection's
// checkpoint. The site (site/transport.ts) calls it with requests it built.
export async function replyTo(
  parts: DaemonParts,
  req: ReplyRequest,
  timedOut: () => boolean,
  accepted: Acceptance,
  clientLeft: () => boolean,
): Promise<Reply> {
  const {
    stats,
    clock,
    frameFeeds,
    renderer,
    payloadProviders: { gitProvider, usageStore },
    fileEvents,
    runs,
    sourceRuns,
    watcherRegistry,
    limits,
    renderSightings,
    bundle,
    sourceDigest,
  } = parts;
  if (req.kind === "shutdown") {
    return replyOf({ ok: true, output: "" }, 0);
  }
  if (req.kind === "recording") {
    try {
      const command = recordingCommandOf(req.command);
      return stay({ ok: true, output: await parts.recordRenderer(command) });
    } catch (error) {
      const failure = failureOf(error);
      return stay({
        ok: false,
        code: failure.kind === "bad-request" ? "BAD_REQUEST" : "RENDER_FAILED",
        error: failure.message,
        daemonV: PROTOCOL_VERSION,
      });
    }
  }

  if (req.kind === "pane-session") {
    // [LAW:parse-dont-validate] Trust boundary: both are untrusted JSON.
    const { socket, pane } = req as { socket: unknown; pane: unknown };
    if (typeof socket !== "string" || typeof pane !== "string")
      return stay({
        ok: false,
        error: "pane-session needs a string socket and pane",
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
    return stay({
      ok: true,
      paneSession: frameFeeds.newestWhere(
        ({ hints: { tmux } }) =>
          tmux !== null &&
          tmux !== undefined &&
          tmux.socket === socket &&
          tmux.pane === pane,
      ),
    });
  }

  if (req.kind === "pointer") {
    const session = parseSessionId(req.sessionId);
    if (!session.ok)
      return refusal("BAD_REQUEST", `pointer's sessionId ${session.problem}`);
    const owner = parseOwner(req.owner);
    if (owner.kind !== "ok")
      return refusal("BAD_REQUEST", `pointer's ${owner.reason}`);
    const admitted = frameFeeds.pointerOf(session.id, owner.value);
    return admitted.kind === "ok"
      ? stay({ ok: true, output: "" })
      : refusal("BAD_REQUEST", admitted.reason);
  }

  if (req.kind === "stats") {
    // [LAW:single-enforcer] Stats requests do NOT bump request counters —
    // observability shouldn't pollute the metric being observed.
    // [LAW:nothing-unseen] Each mailbox as the request found it, before its
    // own input joins it: the input holding it and everything ahead.
    const held = parts
      .renderers()
      .map((runtime) => ({ ...runtime, mailbox: runtime.renderer.stats() }));
    const renderers = await Promise.all(
      held.map(({ renderer, process, mailbox }) =>
        rendererPanel(
          {
            name: renderer.name,
            ask: (until) =>
              renderer
                .command({ kind: "stats" }, until)
                .then(({ stats }) => stats),
            process,
            mailbox,
          },
          limits,
          clock,
          parts.closing,
        ),
      ),
    );
    return stay({
      ok: true,
      stats: stats.snapshot({
        gitCache: gitProvider.getStats(),
        usageCache: usageStore.getStats(),
        sources: sourceSnapshots(parts),
        fileEvents: fileEvents.stats(),
        sourceRuns: sourceRuns.stats(),
        runs: runs.stats(),
        transcriptReads: transcriptReads(),
        collector: parts.collector.stats(),
        frameFeeds: frameFeeds.getStats(),
        watchersActive: watcherRegistry.size(),
        dirWatchesActive: watcherRegistry.dirWatches(),
        polledPaths: watcherRegistry.polledPaths(),
        clients: renderSightings.list(instantAt(clock)),
        bundle,
        sourceDigest,
        linkKeyId: parts.linkSigner.keyId(),
        host: limits.host(),
        renderers,
      }),
    });
  }

  if (req.kind === "render" || req.kind === SESSION_RENDER_KIND) {
    // [LAW:effects-at-boundaries] The render request's two clock reads: the
    // instant it arrived at, which its client sightings are stamped with, and the
    // monotonic start its wait and duration are measured from, so a clock
    // stepped meanwhile moves neither. The bar is drawn at its turn's own
    // readings, made as its slot comes.
    const started = new Date(clock.now());
    const at = instantOf(started);
    const t0 = clock.monotonic();
    const queuedMs = spanMs(accepted.at, t0);
    // [LAW:nothing-unseen] One render event per render request, written here
    // on every exit — a refusal and a throw included — from the facts the
    // render reached, so a failing render is described like any other.
    // A throw is this request's own RENDER_FAILED reply, so the event is the
    // one record of it and the connection's catch never sees a render.
    const facts: RequestFacts = [];
    // Where this request came in the order they arrived: renders of one session
    // can finish out of it.
    // [LAW:one-source-of-truth] The request's id, its place in the order the
    // daemon accepted requests, is that order.
    const order = accepted.id;
    // [LAW:single-enforcer] A render REQUEST is a client sighting — the
    // frames a feed draws from a session's data are not, so this is the one
    // write, here rather than in drawRender. It is written as the request
    // arrives, `drawing`, and again once its render settles, carrying what the
    // frame drew — both stamped with the instant and order it arrived in.
    const sighted = (req: CheckedRenderRequest, frame: FrameSeen): void =>
      renderSightings.see(
        req.hookData.session_id,
        {
          client: req.hints.client ?? null,
          termCols: req.hints.termCols ?? null,
          rateLimits: req.rateLimits,
          claudeConfigDir: claudeConfigDir(
            req.hints.claudeConfigDir,
            parts.home,
          ),
          projectDir: req.requested.projectDir,
          transcript: transcriptSaid(req.hookData),
          frame,
        },
        at,
        order,
      );
    // The request's event, written on every exit, and its reply.
    const recorded = ({
      reply,
      outcome,
    }: ReturnType<typeof renderRecord>): Reply => {
      if (outcome.kind !== "ok") stats.requestsErrored++;
      // Whether the client was already told TIMEOUT while this render ran on,
      // and how long the request was queued, from the connection's accept,
      // before it began: the daemon's own delay and the client's sending of its
      // frame both count, so a round trip longer than `took` is time spent
      // there. And which request this was, the id a TIMEOUT reply carries.
      noteFacts(facts, {
        req: String(accepted.id),
        timedOut: timedOut() ? "Y" : "N",
        clientLeft: clientLeft() ? "Y" : "N",
        queued: `${queuedMs}ms`,
      });
      const took = elapsedMs(clock, t0);
      stats.recordTook(took);
      const { level, line } = requestEvent("render", facts, outcome, took);
      parts.log(level, line);
      return reply;
    };
    const failedDraw = (error: unknown) => {
      const failure = renderFailure(failureOf(error));
      return renderRecord({
        outcome: failure,
        resp: failedWith(failure.message),
        settled: NOTHING_TO_SETTLE,
      });
    };
    let checked: ReturnType<typeof checkRenderRequest>;
    try {
      checked = checkRenderRequest(req, stats, parts.log, parts.home, {
        reportedFor: (session, key) =>
          parts.sessionBook.reportedFor(session, key),
        accountHome: parts.accountHome,
      });
    } catch (error) {
      stats.requestsTotal++;
      return recorded(failedDraw(error));
    }
    if ("need" in checked) {
      stats.environmentMisses++;
      return stay({ ok: true, need: ENVIRONMENT_NEEDED });
    }
    stats.requestsTotal++;
    const draw = async (): Promise<ReturnType<typeof renderRecord>> => {
      let answered: StatuslineAnswer | undefined;
      try {
        if (!checked.ok) return renderRecord(refusedRender(checked.problems));
        const renderer =
          parts.rendererFor?.(checked.req, checked.environment, order) ??
          parts.renderer;
        sighted(checked.req, "drawing");
        // [LAW:one-source-of-truth] A request past the checkpoint is the
        // session's data from now on; a followed session's next frame is drawn
        // from it, brought forward as its view takes it up. Its answer is its
        // own client's, drawn for a request and never pushed: its `encoding`
        // says how that answer is spelled, and no feed reads it
        // (src/daemon/frame-feed.ts).
        frameFeeds.note(checked.req.hookData.session_id, checked.req, order);
        // [LAW:one-source-of-truth] The book keeps what the newest request says,
        // never one that arrived behind it.
        if (frameFeeds.latest(checked.req.hookData.session_id) === checked.req)
          parts.sessionBook.heard(
            checked.req,
            checked.registration ?? checked.environment,
          );
        const tmux = checked.req.hints.tmux;
        if (tmux != null)
          clock.detach(`tmux status observe ${tmux.socket}`, () =>
            parts.retiredTmuxStatus.observe(tmux.socket),
          );
        const { waitEndsAt, clientEndsAt } = renderDeadlines(
          checked.req.deadline,
          accepted.at,
          { epochMs: started.getTime(), monoMs: t0 },
        );
        answered = await answerStatusline(
          renderer,
          parts.publishFrame,
          parts.collector,
          clock,
          parts.closing,
          parts.log,
          parts.checkoutLocation,
          checked.req,
          // [LAW:one-source-of-truth] The book's, the newest request's, so a
          // request that arrived behind a newer one runs nothing in its older
          // environment.
          parts.sessionBook.environmentOf(checked.req.hookData.session_id),
          order,
          {
            waitEndsAt,
            // [LAW:no-ambient-temporal-coupling] Loss of the only recipient
            // comes from the connection's phase or its reply deadline.
            gone: () =>
              timedOut() ||
              clientLeft() ||
              (clientEndsAt !== null && clock.monotonic() >= clientEndsAt),
          },
          facts,
        );
        noteFacts(facts, cacheTallyFacts(parts.payloadProviders));
        const rendered = renderRecord(answered);
        sighted(
          checked.req,
          rendered.reply.unsent === null ? answered.seen : "failed",
        );
        return rendered;
      } catch (error) {
        // [LAW:single-enforcer] If the answer never reaches the connection,
        // it still settles the present that the renderer handed back.
        answered?.settled(false);
        return failedDraw(error);
      }
    };
    return recorded(await draw());
  }

  if (req.kind === "click") {
    const { outcome } = await clickEvent(
      parts,
      accepted,
      timedOut,
      clientLeft,
      (facts, click) => clickOutcome(parts, req, facts, click),
    );
    return stay(clickReply(outcome));
  }

  if (req.kind === "debug") {
    // [LAW:single-enforcer] One trust-boundary check at the wire edge —
    // `what` is untrusted JSON. isDebugWhat narrows it to the discriminated
    // union the introspector consumes; an invalid value short-circuits
    // here, not deep inside buildDebugSnapshot.
    if (!isDebugWhat(req.what)) {
      return stay({
        ok: false,
        // [LAW:no-silent-failure] Include the allowed values so a
        // CLI consumer (or operator) sees what is supported without
        // grep — same pattern as the set-state verb's unknown-key error
        // in src/daemon/foundations/state-validators.ts.
        error: `unknown debug 'what': ${String(req.what)} (have: ${DEBUG_WHATS.join(", ")})`,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
    }
    const { snapshot } = await renderer.command({
      kind: "debug",
      what: req.what,
    });
    return stay({ ok: true, debug: snapshot });
  }

  const unanswered: never = req;
  throw new Error(`no reply for request ${inspect(unanswered)}`);
}

// [LAW:no-ambient-temporal-coupling] How long the stats reply waits for any
// one renderer's own answer: half the connection backstop's bound on the
// request, so the host's snapshot and the write fit in the rest.
export const RENDERER_STATS_WAIT_MS = REQUEST_TIMEOUT_MS / 2;

// [LAW:one-type-per-behavior] One renderer's panel, built alike for every
// renderer: its memory where it is, its mailbox, and its own answer of
// itself, or why there was none, so one renderer that cannot answer fails its
// panel and not the reply. One not running is not asked, so a stats request
// is no input it refused, and one starting or busy is waited for only as
// long as the reply can spare: its mailbox says what holds it.
export async function rendererPanel(
  {
    name,
    ask,
    process: state,
    mailbox,
  }: {
    readonly name: RendererName;
    // Its own answer of itself, through its mailbox, while it is waited for.
    readonly ask: (until: AbortSignal) => Promise<RendererStats>;
    readonly process: RendererProcessState;
    readonly mailbox: MailboxStats;
  },
  limits: Pick<DaemonParts["limits"], "renderer">,
  clock: Pick<DaemonParts["clock"], "after" | "failed">,
  closing: AbortSignal,
): Promise<RendererPanel> {
  return {
    name,
    process: memoryPanelOf(state, limits),
    mailbox,
    stats:
      state.kind === "not-running"
        ? {
            kind: "failed",
            reason: `not asked: it is not running: ${state.why}`,
          }
        : await askedWithin(name, ask, clock, closing),
  };
}

// [LAW:single-enforcer] The one bounded wait, so a reply the close ends
// stops waiting with it.
async function askedWithin(
  name: RendererName,
  ask: (until: AbortSignal) => Promise<RendererStats>,
  clock: Pick<DaemonParts["clock"], "after" | "failed">,
  closing: AbortSignal,
): Promise<Asked<RendererStats>> {
  try {
    const waited = await waitWithin(
      `renderer ${name} stats wait`,
      ask,
      RENDERER_STATS_WAIT_MS,
      clock,
      closing,
    );
    switch (waited.end) {
      case "answered":
        return { kind: "ok", value: waited.value };
      case "deadline":
        return {
          kind: "failed",
          reason: `no answer within ${RENDERER_STATS_WAIT_MS} ms`,
        };
      case "closed":
        return { kind: "failed", reason: "the daemon closed" };
    }
  } catch (thrown) {
    return { kind: "failed", reason: failureOf(thrown).detail };
  }
}

// Where a renderer's memory is, as its panel says it: a process of its own is
// read against the limit as the backstop last read it.
function memoryPanelOf(
  state: RendererProcessState,
  limits: Pick<DaemonParts["limits"], "renderer">,
): RendererMemoryPanel {
  switch (state.kind) {
    case "in-host":
    case "not-running":
      return state;
    case "spawned":
      return { kind: "process", memory: limits.renderer(state.process) };
  }
}

// [LAW:nothing-unseen] Every source's refreshes from the one ledger, beside
// how many homes of each scope the host's owners keep and how many a view
// holds.
function sourceSnapshots(parts: DaemonParts): SourceSnapshots {
  const {
    payloadProviders: {
      gitProvider,
      tmuxService,
      usageStore,
      managedStorage,
      hostService,
      transcriptLanes,
    },
    refreshLedger,
  } = parts;
  const git = gitProvider.getStats();
  const tmux = tmuxService.getStats();
  const today = usageStore.scanStats();
  const storage = managedStorage.stats();
  return {
    records: refreshLedger.snapshot(),
    homes: {
      daemon: 1,
      configDir: today.entries,
      repo: git.size,
      session: usageStore.getStats().size,
      pane: tmux.entries,
    },
    held: {
      git: git.held,
      tmux: tmux.held,
      host: hostService.held(),
      today: today.held,
      pluginStorage: storage.held,
      transcript: transcriptLanes.stats().held,
    },
    pluginStorage: {
      folders: storage.folders,
      faults: storage.faults,
      lost: storage.lost,
    },
  };
}

// [LAW:nothing-unseen][LAW:single-enforcer] One click event per click,
// however it arrived (a `click` request, the URL handler's frame), whatever
// its outcome: how long it was queued behind the loop from its accept, how
// long it then took, and what it learned on the way (who delivered it, a
// status-line click's link, the verb that ran, its session). A field absent
// means it stopped before it.
async function clickEvent(
  parts: DaemonParts,
  accepted: Acceptance,
  timedOut: () => boolean,
  clientLeft: () => boolean,
  run: (facts: RequestFacts, click: ClickInFlight) => Promise<Clicked>,
): Promise<Clicked> {
  const { clock } = parts;
  const t0 = clock.monotonic();
  const facts: RequestFacts = [
    ["req", String(accepted.id)],
    ["queued", `${spanMs(accepted.at, t0)}ms`],
  ];
  // When a click still waiting in the mailbox is refused: its client was told
  // TIMEOUT, which says the click did not run, or a client that waited for the
  // answer left. The connection knows which clients wait (a url frame's writer
  // is unattended, even one that reads its verdict after the click, since its
  // hanging up costs the click nothing), so its `clientLeft` already says so.
  // How long its turn took to come refuses nothing.
  const click: ClickInFlight = {
    gone: () => timedOut() || clientLeft(),
  };
  // [LAW:single-enforcer] Whatever a click throws is its outcome, whichever
  // arm it took, so every click writes its event.
  const clicked = await run(facts, click).catch((thrown: unknown) =>
    noDesktop(failureOf(thrown)),
  );
  // Whether the client was told TIMEOUT, and whether a client that waited
  // hung up, by the time the click was done.
  noteFacts(facts, {
    timedOut: timedOut() ? "Y" : "N",
    clientLeft: clientLeft() ? "Y" : "N",
  });
  const { level, line } = requestEvent(
    "click",
    facts,
    clicked.outcome,
    elapsedMs(clock, t0),
  );
  parts.log(level, line);
  return clicked;
}

// A click as it ended: its outcome, and the acts it left to the desktop the
// person sits at, in the order asked.
interface Clicked {
  readonly outcome: RequestOutcome;
  readonly desktop: readonly DesktopAct[];
}
const noDesktop = (outcome: RequestOutcome): Clicked => ({
  outcome,
  desktop: [],
});

// [LAW:single-enforcer] The verdict of a writer told once its click landed:
// what the click came to and the acts it left for the writer to carry out,
// which a click that failed after asking them leaves too, as it would on a bar
// of the writer's own machine. [LAW:no-silent-failure] A verdict its writer
// never took (it gave up waiting) takes its acts with it, and the daemon says
// so.
function landedReply(parts: DaemonParts, { outcome, desktop }: Clicked): Reply {
  const said = clickReply(outcome);
  return replyOf(
    said.ok
      ? { ok: true, output: "", desktopActs: desktop }
      : { ...said, desktopActs: desktop },
    null,
    (taken) => {
      if (!taken && desktop.length > 0)
        parts.log(
          "warn",
          `${desktop.length} copy or open act(s) for the desktop the person sits at were not carried out: the URL handler left before the verdict that carries them`,
        );
    },
  );
}

// [LAW:parse-dont-validate][LAW:no-silent-failure] A click request run to its
// outcome. Its url is untrusted JSON, refused here unless it is a string, and
// whatever the click then throws is its outcome too, so every click writes its
// event: a refusal of the link or its arguments is a bad request, and anything
// else thrown is the daemon's failure — a program the click ran, or a bug —
// recorded with the stack that says which.
async function clickOutcome(
  parts: DaemonParts,
  req: { readonly url: unknown },
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<Clicked> {
  noteFacts(facts, { via: "cli" });
  const { url } = req;
  if (typeof url !== "string")
    return noDesktop(
      badRequest(`a click's url is a string, got ${typeof url}`),
    );
  return ranClick(
    parts,
    routeClick(parts, parseClick(url, { kind: "cli" }, parts.linkSigner)),
    "daemon",
    facts,
    click,
  );
}

// [LAW:parse-dont-validate] The URL handler's frame as a click: a frame of a
// version the daemon does not speak, or one with no url, is refused like a
// link that does not open.
// The frame's one reading of where its click's acts go (`actsOn`), so the
// verdict's timing and the click's arrival cannot disagree about it: a frame
// that names a place this daemon does not know, or asks a version 1 writer
// (which reads no verdict, so cannot carry the acts) to carry them, is refused.
interface FrameRead {
  readonly read: ReadClick;
  readonly place: ActsOn["on"];
}

function readUrlFrame(
  frame: Record<string, unknown>,
  links: LinkSigner,
): FrameRead {
  const refused = (problem: string): FrameRead => ({
    read: { kind: "refused", problem },
    place: "daemon",
  });
  const { urlV, url, actsOn } = frame;
  if (typeof urlV !== "number" || !URL_FRAME_VERSIONS.has(urlV))
    return refused(
      `the URL handler's frame version ${inspect(urlV)} is not one this daemon speaks (${[...URL_FRAME_VERSIONS].join(", ")})`,
    );
  if (typeof url !== "string")
    return refused("the URL handler's frame carries no url string");
  if (actsOn !== undefined && actsOn !== ACTS_ON_DESKTOP)
    return refused(
      `the URL handler's frame names ${inspect(actsOn)} for its acts, which this daemon does not know (${ACTS_ON_DESKTOP})`,
    );
  if (actsOn === ACTS_ON_DESKTOP && !awaitsVerdict(urlV))
    return refused(
      `the URL handler's frame version ${urlV} reads no verdict, which carries the acts it asks for`,
    );
  return {
    read: parseClick(url, { kind: "forwarder", urlV }, links),
    place: actsOn === ACTS_ON_DESKTOP ? "desktop" : "daemon",
  };
}

// [LAW:no-silent-failure] The URL handler's frame, answered with its verdict
// the moment it is read and run to its outcome after. A link that does not
// open is refused here, as a bad request on the click's event and in the
// verdict, whose writer shows it as a notification, never dropped. A verb's
// own failure is held on the bar, so the verdict does not say it twice.
function urlClick(
  parts: DaemonParts,
  frame: Record<string, unknown>,
  timedOut: () => boolean,
  accepted: Acceptance,
  clientLeft: () => boolean,
): HandledRequest {
  const { read: parsed, place } = readUrlFrame(frame, parts.linkSigner);
  const read = routeClick(parts, parsed);
  // A writer that carries out its click's acts is told what the click came to,
  // once it landed; any other, at once, whether its link opened.
  const told: Told =
    read.kind === "link" && place === "desktop"
      ? { when: "landed" }
      : toldAtOnce(
          frame.urlV,
          read.kind === "refused"
            ? clickReply(read.failure)
            : { ok: true, output: "" },
        );
  return {
    kind: "url",
    told,
    land: async () =>
      landedReply(
        parts,
        await clickEvent(
          parts,
          accepted,
          timedOut,
          clientLeft,
          async (facts, click) => {
            noteFacts(facts, { via: "forwarder", urlV: String(frame.urlV) });
            return ranClick(parts, read, place, facts, click);
          },
        ),
      ),
  };
}

type ClickLink = Extract<ReadClick, { kind: "link" }>;
type RoutedClick =
  | (ClickLink & { readonly target: RendererHost })
  | {
      readonly kind: "refused";
      readonly failure: Failure;
      readonly signed: Extract<ReadClick, { kind: "refused" }>["signed"];
    };

// [LAW:single-enforcer] Both entrances resolve the signed publisher before
// they promise delivery. A link never admits a renderer bundle of its own.
function routeClick(parts: DaemonParts, read: ReadClick): RoutedClick {
  if (read.kind === "refused")
    return {
      kind: "refused",
      failure: badRequest(read.problem),
      signed: read.signed,
    };

  const { source } = read;
  if (source === undefined) return { ...read, target: parts.renderer };
  const target = parts.rendererForClick(source.renderer);
  return target === undefined
    ? {
        kind: "refused",
        failure: failureOf(
          new RendererDown(
            `renderer ${source.renderer} has no statusline client's bundle`,
          ),
        ),
        signed: { link: read.link, verb: read.click.verb },
      }
    : { ...read, target };
}

// [LAW:types-are-the-program] A refused click has an outcome already.
// An admitted click enters the renderer mailbox.
async function ranClick(
  parts: DaemonParts,
  read: RoutedClick,
  place: ActsOn["on"],
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<Clicked> {
  switch (read.kind) {
    case "refused":
      if (read.signed !== undefined) noteFacts(facts, read.signed);
      return noDesktop(read.failure);
    case "link":
      noteFacts(facts, { link: read.link });
      return handleClick(parts, read, place, facts, click);
  }
}

// [LAW:single-enforcer] The one place a click's copy and open are given their
// destination: a click that acts on the desktop the person sits at holds a
// place in the desktop acts from the moment it is handed to the renderer until
// its landing is over, and what it asked in that time, in whichever turn,
// is its own. The acts of a click whose id is not held go to no verdict.
async function handleClick(
  parts: DaemonParts,
  link: Extract<RoutedClick, { kind: "link" }>,
  place: ActsOn["on"],
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<Clicked> {
  const { delivery } = link;
  if (place === "daemon")
    return noDesktop(
      await deliverClick(
        parts,
        link,
        { via: "link", delivery, acts: ACTS_ON_DAEMON },
        facts,
        click,
      ),
    );
  const held = parts.desktopActs.begin();
  let outcome: RequestOutcome;
  let desktop: readonly DesktopAct[];
  try {
    outcome = await deliverClick(
      parts,
      link,
      { via: "link", delivery, acts: { on: "desktop", click: held } },
      facts,
      click,
    );
  } finally {
    desktop = parts.desktopActs.end(held);
  }
  return { outcome, desktop };
}

// [LAW:single-enforcer] A click that runs a verb is one turn of the renderer,
// which decides what it means and acts on it (src/renderer/click.ts); the
// host parses its session at the one session-id checkpoint, holds the session
// for as long as the turn runs, and records the turn on the click's event.
// [LAW:types-are-the-program] A turn that threw is the click's outcome by its
// failure's kind, never by its message (`failureOf`): a bad argument (an
// unknown verb, invalid arguments) is a bad request, anything else the
// daemon's failure.
async function deliverClick(
  parts: DaemonParts,
  {
    click: admitted,
    runEvidence,
    target,
  }: Extract<RoutedClick, { kind: "link" }>,
  arrival: Extract<ClickArrival, { via: "link" }>,
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<RequestOutcome> {
  const { verb } = admitted;
  const session = admitted.session ?? null;
  noteFacts(facts, { verb, sid: session ?? "-", renderer: target.name });
  if (session !== null) parts.collector.clicked(session);
  // [LAW:no-ambient-temporal-coupling] Made as its turn comes: a click whose
  // client took a TIMEOUT never lands, since TIMEOUT told that client it did
  // not run, and one whose client left while it waited has no one to answer.
  const delivered = await target.answerClick(session, () =>
    click.gone()
      ? failureOf(new ClickAbandoned(verb))
      : {
          kind: "event",
          runEvidence,
          event: {
            kind: "click",
            click: admitted,
            arrival,
            context:
              admitted.scope === "global"
                ? null
                : parts.sessionBook.contextOf(
                    admitted.session,
                    parts.frameFeeds.latest(admitted.session),
                  ),
          },
        },
  );
  // [LAW:nothing-unseen] How long the click waited for the renderer's turn.
  noteFacts(facts, { mailbox: `${delivered.queuedMs}ms` });
  facts.push(...delivered.record);
  if (delivered.kind === "threw") return delivered.failure;
  // [LAW:no-silent-failure] A click whose changes did not land, or whose act
  // did not go, says so in its answer: by the first that did not. A skipped
  // act's cause is its changes' own outcome, which answers instead.
  const missed = delivered.settled.find(
    (outcome): outcome is Answering =>
      outcome.kind !== "ok" && outcome.kind !== "skipped",
  );
  return missed === undefined ? { kind: "ok" } : clickFailure(missed);
}

type Answering = Exclude<EffectOutcome, { kind: "ok" | "skipped" }>;

// [LAW:types-are-the-program] An effect's outcome as its click's: a refusal is
// the user's to act on, a close is the daemon's, anything else failed.
function clickFailure(outcome: Answering): RequestOutcome {
  const kind = CLICK_FAILURE[outcome.kind];
  return { kind, message: outcome.reason, detail: outcome.reason };
}

const CLICK_FAILURE = {
  refused: "bad-request",
  failed: "threw",
  closing: "closing",
} as const;

// [LAW:single-enforcer] The reply a click's outcome is answered with.
function clickReply(
  outcome: RequestOutcome,
): Exclude<Response, { code: "TIMEOUT" }> {
  switch (outcome.kind) {
    case "ok":
      return { ok: true, output: "" };
    case "bad-request":
      return {
        ok: false,
        error: outcome.message,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      };
    case "threw":
    case "closing":
    case "abandoned":
    case "down":
      return failedWith(outcome.message);
  }
}

// The answer to a request the checkpoint refused.
const refusedRender = (problems: string[]) => ({
  outcome: badRequest(...problems),
  resp: {
    ok: false,
    error: `malformed hookData: ${problems.join("; ")}`,
    code: "BAD_REQUEST",
    daemonV: PROTOCOL_VERSION,
  } satisfies Response,
  settled: NOTHING_TO_SETTLE,
});
