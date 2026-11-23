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
import type { EffectOutcome } from "../renderer-interface/interface.js";
import { type CheckedRenderRequest } from "../renderer-interface/request-context.js";
import {
  PROTOCOL_VERSION,
  SESSION_RENDER_KIND,
  ENVIRONMENT_NEEDED,
  UNKNOWN_REQUEST_KIND,
  URL_FRAME_VERSIONS,
  awaitsVerdict,
  type Inbound,
  type Request,
  type Response,
  type SubscribeRequest,
} from "./foundations/protocol";
import { parseSessionId, type SessionId } from "./foundations/session-id";
import { type SourceSnapshots } from "./foundations/stats-snapshot";
import { type LinkSigner } from "../click/link-signer.js";
import { parseClick, type ReadClick } from "./click-reading.js";
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
import { transcriptReads } from "../utils/transcript-fs.js";
import type { ClickArrival } from "../renderer-interface/click-arrival";
import { transcriptSaid } from "./render-sightings";
import { type FrameSeen } from "./foundations/sightings";
import { claudeConfigDir } from "../claude-settings";
import { DEBUG_WHATS, isDebugWhat } from "./foundations/debug-types";
import { recordingCommandOf } from "./foundations/recording-command.js";
import { LANE_NAMES, parseLane, type Lane } from "../config/lanes.js";
import { instantAt, instantOf } from "../utils/instant.js";
import { renderDeadlines } from "./foundations/request-deadline.js";
import type { RendererStats } from "../renderer-interface/interface.js";
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
// exit" (the shutdown verb, the stale-binary version mismatch) must not exit
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
  | { kind: "subscribe"; sessionId: SessionId; lane: Lane }
  | {
      kind: "url";
      // Whether the frame's writer reads `verdict`.
      awaitsVerdict: boolean;
      verdict: Response;
      // [LAW:no-ambient-temporal-coupling] The click, started by whoever
      // wrote the verdict once it is written, so no work of the click's
      // stands before it. Settles once the click's event is written.
      land: () => Promise<void>;
    };

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
  return inbound.kind === "url"
    ? {
        kind: "url",
        awaitsVerdict: awaitsVerdict(inbound.frame.urlV),
        verdict: closingResponse(parts, "click", accepted),
        land: async () => {},
      }
    : replied(refuseClosingReply(parts, inbound.req?.kind, accepted));
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
const refuse = (
  code: "BAD_REQUEST" | "VERSION_MISMATCH",
  error: string,
): HandledRequest =>
  replied(stay({ ok: false, error, code, daemonV: PROTOCOL_VERSION }));

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
  return { kind: "subscribe", sessionId: sessionId.id, lane };
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
    // [LAW:types-are-the-program] The asymmetry is data, not control flow.
    //   client > daemon: the *binary* probably upgraded under us. Exit so the
    //     next client respawns from the current artifact.
    //   client < daemon: the *client* is stale. Respawning daemon does not
    //     help (the new daemon will have the same version). Stay up and
    //     return VERSION_MISMATCH — the client is responsible for surfacing
    //     the diagnostic and refusing to kick. Shutting down here was the
    //     load-bearing half of the 452-corpse spiral (kz8.5).
    if (req.v > PROTOCOL_VERSION) {
      parts.log(
        "info",
        `version mismatch: client=${req.v} > daemon=${PROTOCOL_VERSION}; binary likely upgraded — exiting after the response flushes`,
      );
    } else {
      parts.log(
        "info",
        `version mismatch: client=${req.v} < daemon=${PROTOCOL_VERSION}; client is stale — staying up`,
      );
    }
    return replied(
      replyOf(
        {
          ok: false,
          error: `protocol v${req.v} not supported (daemon at v${PROTOCOL_VERSION})`,
          code: "VERSION_MISMATCH",
          daemonV: PROTOCOL_VERSION,
        },
        // [LAW:dataflow-not-control-flow] The asymmetry above is this value.
        // Exit is sequenced on the response flush, so the client always sees
        // the VERSION_MISMATCH diagnostic — never a dead socket.
        req.v > PROTOCOL_VERSION ? 0 : null,
      ),
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

  if (req.kind === "stats") {
    // [LAW:single-enforcer] Stats requests do NOT bump request counters —
    // observability shouldn't pollute the metric being observed.
    // [LAW:nothing-unseen] The mailbox as the request found it, before its
    // own input joins it: the input holding it and everything ahead.
    const mailbox = parts.renderer.stats();
    const {
      stats: { framesDrawn, ...drawn },
    } = await renderer.command({ kind: "stats" });
    return stay({
      ok: true,
      stats: stats.snapshot({
        gitCache: gitProvider.getStats(),
        usageCache: usageStore.getStats(),
        sources: sourceSnapshots(parts, drawn.renderCache),
        fileEvents: fileEvents.stats(),
        sourceRuns: sourceRuns.stats(),
        runs: runs.stats(),
        transcriptReads: transcriptReads(),
        ...drawn,
        collector: parts.collector.stats(),
        mailbox,
        // The frames drawn are the renderer's count, the rest the host's.
        frameFeeds: { ...frameFeeds.getStats(), drawn: framesDrawn },
        watchersActive: watcherRegistry.size(),
        dirWatchesActive: watcherRegistry.dirWatches(),
        polledPaths: watcherRegistry.polledPaths(),
        nextRestartReason: limits.describeNextRestart(),
        clients: renderSightings.list(instantAt(clock)),
        bundle,
        sourceDigest,
        daemon: limits.serving(),
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
    return stay(
      await clickEvent(parts, accepted, timedOut, clientLeft, (facts, click) =>
        clickOutcome(parts, req, facts, click),
      ),
    );
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

// [LAW:nothing-unseen] Every source's refreshes from the one ledger, beside
// how many homes of each scope the owners keep and how many a view holds.
function sourceSnapshots(
  parts: DaemonParts,
  cache: RendererStats["renderCache"],
): SourceSnapshots {
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
      directory: cache.size,
      session: usageStore.getStats().size,
      view: cache.views,
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
  run: (facts: RequestFacts, click: ClickInFlight) => Promise<RequestOutcome>,
): Promise<Response> {
  const { clock } = parts;
  const t0 = clock.monotonic();
  const facts: RequestFacts = [
    ["req", String(accepted.id)],
    ["queued", `${spanMs(accepted.at, t0)}ms`],
  ];
  // When a click still waiting in the mailbox is refused: the daemon's
  // deadline, or a client that waited for the answer leaving. The connection
  // knows which clients wait (the forwarder does not), so its `clientLeft`
  // already says so.
  const click: ClickInFlight = {
    gone: () => timedOut() || clientLeft(),
  };
  // [LAW:single-enforcer] Whatever a click throws is its outcome, whichever
  // arm it took, so every click writes its event.
  const outcome = await run(facts, click).catch(failureOf);
  // Whether the client was told TIMEOUT, and whether a client that waited
  // hung up, by the time the click was done. Only a url frame's click, whose
  // writer waits for no answer, can land with `timedOut=Y`.
  noteFacts(facts, {
    timedOut: timedOut() ? "Y" : "N",
    clientLeft: clientLeft() ? "Y" : "N",
  });
  const { level, line } = requestEvent(
    "click",
    facts,
    outcome,
    elapsedMs(clock, t0),
  );
  parts.log(level, line);
  return clickReply(outcome);
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
): Promise<RequestOutcome> {
  noteFacts(facts, { via: "cli" });
  const { url } = req;
  if (typeof url !== "string")
    return badRequest(`a click's url is a string, got ${typeof url}`);
  return ranClick(
    parts,
    routeClick(parts, parseClick(url, { kind: "cli" }, parts.linkSigner)),
    facts,
    click,
  );
}

// [LAW:parse-dont-validate] The URL handler's frame as a click: a frame of a
// version the daemon does not speak, or one with no url, is refused like a
// link that does not open.
function readUrlFrame(
  frame: Record<string, unknown>,
  links: LinkSigner,
): ReadClick {
  const { urlV, url } = frame;
  if (typeof urlV !== "number" || !URL_FRAME_VERSIONS.has(urlV))
    return {
      kind: "refused",
      problem: `the URL handler's frame version ${inspect(urlV)} is not one this daemon speaks (${[...URL_FRAME_VERSIONS].join(", ")})`,
    };
  if (typeof url !== "string")
    return {
      kind: "refused",
      problem: "the URL handler's frame carries no url string",
    };
  return parseClick(url, { kind: "forwarder", urlV }, links);
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
  const read = routeClick(parts, readUrlFrame(frame, parts.linkSigner));
  return {
    kind: "url",
    awaitsVerdict: awaitsVerdict(frame.urlV),
    verdict:
      read.kind === "refused"
        ? clickReply(read.failure)
        : { ok: true, output: "" },
    land: () =>
      clickEvent(
        parts,
        accepted,
        timedOut,
        clientLeft,
        async (facts, click) => {
          noteFacts(facts, { via: "forwarder", urlV: String(frame.urlV) });
          return ranClick(parts, read, facts, click);
        },
      ).then(() => {}),
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
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<RequestOutcome> {
  switch (read.kind) {
    case "refused":
      if (read.signed !== undefined) noteFacts(facts, read.signed);
      return read.failure;
    case "link":
      noteFacts(facts, { link: read.link });
      return handleClick(
        parts,
        read,
        { via: "link", delivery: read.delivery },
        facts,
        click,
      );
  }
}

// [LAW:single-enforcer] A click that runs a verb is one turn of the renderer,
// which decides what it means and acts on it (src/renderer/click.ts); the
// host parses its session at the one session-id checkpoint, holds the session
// for as long as the turn runs, and records the turn on the click's event.
// [LAW:types-are-the-program] A turn that threw is the click's outcome by its
// failure's kind, never by its message (`failureOf`): a bad argument (an
// unknown verb, invalid arguments) is a bad request, anything else the
// daemon's failure.
async function handleClick(
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
  // client took a TIMEOUT or left while it waited never lands, so clicking
  // again cannot revert a toggle.
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
function clickReply(outcome: RequestOutcome): Response {
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
