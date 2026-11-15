// A daemon's answer to a request: the checkpoint, then a reply per kind.

import process from "node:process";
import { inspect } from "node:util";
import type { DaemonParts } from "./daemon-parts.js";
import { cacheTallyFacts } from "./readings.js";
import { failedWith, renderFailure } from "./foundations/render-answers.js";
import type { ClickInFlight } from "./clicks-in-flight.js";
import {
  answerStatusline,
  NOTHING_TO_SETTLE,
  type StatuslineAnswer,
} from "./statusline-answer.js";
import { checkRenderRequest } from "./render-checkpoint.js";
import { type CheckedRenderRequest } from "../renderer-interface/request-context.js";
import {
  PROTOCOL_VERSION,
  URL_FRAME_VERSIONS,
  type ClickRequest,
  type Inbound,
  type Request,
  type Response,
  type SubscribeRequest,
} from "./foundations/protocol";
import { parseSessionId, type SessionId } from "./foundations/session-id";
import { type SourceSnapshots } from "./foundations/stats-snapshot";
import { clickHandoff } from "./click-handoff";
import { CLICK_PROGRAM_TIMEOUT_MS } from "./foundations/click-launch";
import {
  clickSessionOf,
  isBarLink,
  parseClick,
  VERB_TMUX_STATUS_CLICK,
} from "../click/wire";
import { badRequest, failureOf, type Failure } from "./foundations/verb-error";
import { elapsedMs, spanMs } from "../time.js";
import { transcriptReads } from "../utils/transcript-fs.js";
import { readStores } from "../doctor/gather";
import type { ClickArrival } from "../doctor/sightings";
import { transcriptSaid } from "./render-sightings";
import { type FrameSeen } from "./foundations/sightings";
import { claudeConfigDir } from "../claude-settings";
import { DEBUG_WHATS, isDebugWhat } from "./foundations/debug-types";
import { LANE_NAMES, parseLane, type Lane } from "../config/lanes.js";
import { instantAt, instantOf } from "../utils/instant.js";
import { waitBudgetMs } from "./foundations/request-deadline.js";
import type { RendererStats } from "../renderer-interface/adapter.js";
import {
  noteFacts,
  requestEvent,
  type Acceptance,
  type RequestFacts,
  type RequestOutcome,
} from "./foundations/request-event.js";

// [LAW:no-ambient-temporal-coupling] A request whose semantics include "then
// exit" (the shutdown verb, the stale-binary version mismatch) must not exit
// until its response has flushed — but handleRequest cannot see the socket.
// So the exit is returned as DATA (the exit code; null = stay up) and the
// connection boundary, which owns the flush, sequences shutdown on the write
// completion. No timer stands between respond and exit.
// [LAW:effects-at-boundaries] handleRequest computes the description; the
// socket boundary performs it.
export interface Reply {
  readonly resp: Response;
  readonly exitAfterFlush: number | null;
  // [LAW:effects-at-boundaries] Told by the reply's sender, once, whether the
  // client took the response — only the connection knows: a render's answer
  // is a present its renderer is owed an `effect-done` for.
  readonly settled: (delivered: boolean) => void;
}
// A subscription is the one request answered by a stream rather than a reply:
// the connection boundary turns its socket over to the session's feed.
export type HandledRequest =
  | ({ kind: "reply" } & Reply)
  | { kind: "subscribe"; sessionId: SessionId; lane: Lane };

const stay = (resp: Response): Reply => ({
  resp,
  exitAfterFlush: null,
  settled: NOTHING_TO_SETTLE,
});
const replied = (reply: Reply): HandledRequest => ({ kind: "reply", ...reply });

// [LAW:types-are-the-program] Every request kind answered with a reply: all
// but a subscribe, the compiler naming one added to the protocol until it is.
export type ReplyRequest = Exclude<Request, SubscribeRequest>;
const REPLY_KINDS: Readonly<Record<ReplyRequest["kind"], true>> = {
  render: true,
  "pane-session": true,
  shutdown: true,
  stats: true,
  click: true,
  debug: true,
};

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
  if (inbound.kind === "url") {
    return replied(
      stay(
        await urlClick(parts, inbound.frame, timedOut, accepted, clientLeft),
      ),
    );
  }
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
    return {
      kind: "reply",
      resp: {
        ok: false,
        error: `protocol v${req.v} not supported (daemon at v${PROTOCOL_VERSION})`,
        code: "VERSION_MISMATCH",
        daemonV: PROTOCOL_VERSION,
      },
      // [LAW:dataflow-not-control-flow] The asymmetry above is this value.
      // Exit is sequenced on the response flush, so the client always sees
      // the VERSION_MISMATCH diagnostic — never a dead socket.
      exitAfterFlush: req.v > PROTOCOL_VERSION ? 0 : null,
      settled: NOTHING_TO_SETTLE,
    };
  }

  if (req.kind === "subscribe") return subscription(req);
  // [LAW:parse-dont-validate] The kind is untrusted JSON: one no request
  // carries — a name no kind has, or no name at all, which `Object.hasOwn`
  // would coerce into one — is refused here, so replyTo is total over the
  // kinds it is typed for.
  if (typeof req.kind !== "string" || !Object.hasOwn(REPLY_KINDS, req.kind))
    return refuse("BAD_REQUEST", "unknown kind");
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
    menuIdle,
    tmuxStatusLines,
    watcherRegistry,
    limits,
    handlerProbes,
    renderSightings,
    bundle,
    sourceDigest,
    doctorStores,
  } = parts;
  if (req.kind === "shutdown") {
    return {
      resp: { ok: true, output: "" },
      exitAfterFlush: 0,
      settled: NOTHING_TO_SETTLE,
    };
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
    const { stats: drawn } = await renderer.ask(
      { kind: "stats" },
      instantAt(clock),
    );
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
        menuIdle: menuIdle.getStats(),
        frameFeeds: frameFeeds.getStats(),
        tmuxStatus: tmuxStatusLines.stats(),
        watchersActive: watcherRegistry.size(),
        dirWatchesActive: watcherRegistry.dirWatches(),
        nextRestartReason: limits.describeNextRestart(),
        handlerProbes: handlerProbes.list(),
        clients: renderSightings.list(instantAt(clock)),
        bundle,
        sourceDigest,
        daemon: limits.serving(),
        doctorStores: readStores(doctorStores),
      }),
    });
  }

  if (req.kind === "render") {
    // [LAW:effects-at-boundaries] The render request's two clock reads: the
    // instant the bar is drawn at (every time read in the render reads it),
    // and the monotonic start its wait and duration are measured from, so a
    // clock stepped meanwhile moves neither.
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
    stats.requestsTotal++;
    // Where this request came in the order they arrived: renders of one session
    // can finish out of it.
    // [LAW:one-source-of-truth] The request's id, its place in the order the
    // daemon accepted requests, is that order.
    const order = accepted.id;
    const checked = checkRenderRequest(req, stats, parts.log, parts.home);
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
    if (checked.ok) {
      sighted(checked.req, "drawing");
      // [LAW:one-source-of-truth] A request past the checkpoint is the
      // session's data from now on; a followed session's next frame is drawn
      // from it, brought forward as its view takes it up. Its answer is its
      // own client's, drawn for a request and never pushed: its `encoding`
      // says how that answer is spelled, and no feed reads it
      // (src/daemon/frame-feed.ts).
      frameFeeds.note(checked.req.hookData.session_id, checked.req, order);
    }
    // The request's event, written on every exit, and its reply.
    const recorded = (rendered: {
      outcome: RequestOutcome;
      resp: Response;
      settled: (delivered: boolean) => void;
    }): Reply => {
      if (rendered.outcome.kind !== "ok") stats.requestsErrored++;
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
      const { level, line } = requestEvent(
        "render",
        facts,
        rendered.outcome,
        elapsedMs(clock, t0),
      );
      parts.log(level, line);
      return {
        resp: rendered.resp,
        exitAfterFlush: null,
        settled: rendered.settled,
      };
    };
    if (!checked.ok) return recorded(refusedRender(checked.problems));
    const answered = await answerStatusline(
      parts.renderer,
      parts.collector,
      parts.menuIdle,
      frameFeeds,
      clock,
      checked.req,
      order,
      at,
      // [LAW:no-ambient-temporal-coupling] When the request's wait ends,
      // fixed at its arrival: early enough before its client hangs up to
      // draw (src/daemon/foundations/request-deadline.ts).
      t0 +
        waitBudgetMs(checked.req.deadline, accepted.at, {
          epochMs: started.getTime(),
          monoMs: t0,
        }),
      facts,
    ).catch(
      // [LAW:no-silent-failure] The driver hands every turn's failure back
      // as a value; a throw here is its own bug, answered as any throw is.
      (error: unknown): StatuslineAnswer => {
        const failure = renderFailure(failureOf(error));
        return {
          outcome: failure,
          resp: failedWith(failure.message),
          seen: "failed",
          settled: NOTHING_TO_SETTLE,
        };
      },
    );
    // [LAW:nothing-unseen] What the host's caches answered by this render's
    // end.
    noteFacts(facts, cacheTallyFacts(parts.payloadProviders));
    // [LAW:single-enforcer] The answer's present is owed its one effect-done
    // on every exit: a reply that never reaches the connection settles here.
    try {
      sighted(checked.req, answered.seen);
      return recorded(answered);
    } catch (e) {
      answered.settled(false);
      throw e;
    }
  }

  if (req.kind === "click") {
    return stay(
      await clickEvent(
        parts,
        accepted,
        timedOut,
        clientLeft,
        (facts, click) => clickOutcome(parts, req, facts, click),
        cliAnswer,
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
    const { snapshot } = await renderer.ask(
      { kind: "debug", what: req.what },
      instantAt(clock),
    );
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
    },
    pluginStorage: {
      folders: storage.folders,
      faults: storage.faults,
      lost: storage.lost,
    },
  };
}

// [LAW:types-are-the-program] A click as the host took it: refused before any
// renderer saw it, or handed to one, with its turn's outcome. The URL handler
// is told only the first, and a turn whose renderer was not there to take it:
// a verb's own failure is held on the bar the click came from.
type Taken =
  | { readonly kind: "refused"; readonly failure: Failure }
  | { readonly kind: "handed"; readonly outcome: RequestOutcome };

const refused = (failure: Failure): Taken => ({ kind: "refused", failure });
const handed = (outcome: RequestOutcome): Taken => ({
  kind: "handed",
  outcome,
});
const outcomeOf = (taken: Taken): RequestOutcome =>
  taken.kind === "refused" ? taken.failure : taken.outcome;

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
  run: (facts: RequestFacts, click: ClickInFlight) => Promise<Taken>,
  reply: (taken: Taken) => Response,
): Promise<Response> {
  const { clock } = parts;
  const t0 = clock.monotonic();
  const facts: RequestFacts = [
    ["req", String(accepted.id)],
    ["queued", `${spanMs(accepted.at, t0)}ms`],
  ];
  // When a click still waiting for its turn is refused: the daemon's deadline,
  // or a client that waited for the answer leaving. The connection knows which
  // clients wait, so its `clientLeft` already says so.
  const click: ClickInFlight = {
    id: accepted.id,
    gone: () => timedOut() || clientLeft(),
  };
  const taken = await run(facts, click);
  // Whether the client was told TIMEOUT, and whether a client that waited
  // hung up, while the click ran: its effect lands though the client reported
  // a failure. One still waiting for its turn at either moment was refused
  // (`abandoned`).
  noteFacts(facts, {
    timedOut: timedOut() ? "Y" : "N",
    clientLeft: clientLeft() ? "Y" : "N",
  });
  const { level, line } = requestEvent(
    "click",
    facts,
    outcomeOf(taken),
    elapsedMs(clock, t0),
  );
  parts.log(level, line);
  return reply(taken);
}

// [LAW:parse-dont-validate][LAW:no-silent-failure] A click request run to its
// outcome. Its link is untrusted JSON, refused here unless it is a string.
async function clickOutcome(
  parts: DaemonParts,
  req: ClickRequest,
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<Taken> {
  noteFacts(facts, { via: "cli" });
  const { url } = req as { url: unknown };
  if (typeof url !== "string") {
    return refused(
      badRequest(`a click carries its link as a url string, got ${typeof url}`),
    );
  }
  return clickArrived(
    parts,
    url,
    { via: "link", delivery: { kind: "cli" } },
    facts,
    click,
  );
}

// [LAW:parse-dont-validate][LAW:no-silent-failure] The URL handler's frame run
// to its outcome. A frame of a version the daemon does not speak, or one with
// no link, is refused here, as a bad request on the event, never dropped.
async function urlClick(
  parts: DaemonParts,
  frame: Record<string, unknown>,
  timedOut: () => boolean,
  accepted: Acceptance,
  clientLeft: () => boolean,
): Promise<Response> {
  return clickEvent(
    parts,
    accepted,
    timedOut,
    clientLeft,
    async (facts, click) => {
      const { urlV, url } = frame;
      noteFacts(facts, { via: "forwarder", urlV: String(urlV) });
      if (typeof urlV !== "number" || !URL_FRAME_VERSIONS.has(urlV)) {
        return refused(
          badRequest(
            `the URL handler's frame version ${inspect(urlV)} is not one this daemon speaks (${[...URL_FRAME_VERSIONS].join(", ")})`,
          ),
        );
      }
      if (typeof url !== "string") {
        return refused(
          badRequest(`the URL handler's frame carries no url string`),
        );
      }
      return clickArrived(
        parts,
        url,
        { via: "link", delivery: { kind: "forwarder", urlV } },
        facts,
        click,
      );
    },
    forwarderAnswer,
  );
}

// [LAW:single-enforcer] Every clicked URL is read here, whichever way it
// arrived, so no link reaches a renderer before its mac is proven
// (parseClick). A tmux range is the link its frame drew there.
async function clickArrived(
  parts: DaemonParts,
  url: string,
  arrival: ClickArrival,
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<Taken> {
  const parsed = parseClick(url, parts.links);
  switch (parsed.kind) {
    case "refused":
      return refused(badRequest(parsed.problem));
    case "range":
      noteFacts(facts, { verb: VERB_TMUX_STATUS_CLICK });
      // What finding the range's link throws (a malformed range) refuses it.
      try {
        return await statusLineClick(parts, parsed.value, facts, click);
      } catch (error) {
        return refused(failureOf(error));
      }
    case "link":
      return handed(
        await clickRan(() =>
          handleClick(parts, parsed.verb, parsed.value, arrival, facts, click),
        ),
      );
  }
}

// What a click that reached its verb became: whatever it throws is its
// outcome, so every click writes its event.
async function clickRan(
  click: () => Promise<RequestOutcome>,
): Promise<RequestOutcome> {
  try {
    return await click();
  } catch (error) {
    return failureOf(error);
  }
}

// [LAW:dataflow-not-control-flow] The field a click records the verb it runs
// under, by how it arrived: a status-line click has already recorded its own
// verb, so the one its link runs is `linkVerb`.
const VERB_FACT: Readonly<Record<ClickArrival["via"], string>> = {
  link: "verb",
  "tmux-status": "linkVerb",
};

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
  verb: string,
  value: string,
  arrival: ClickArrival,
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<RequestOutcome> {
  // [LAW:nothing-unseen] What the host knows of the click is recorded before
  // anything about it can fail: the verb it runs, then its session as it
  // crossed the one session-id checkpoint. One that failed is never recorded,
  // and a click naming none records `sid=-`.
  noteFacts(facts, { [VERB_FACT[arrival.via]]: verb });
  const session = clickSessionOf(verb, value);
  if (session === null) noteFacts(facts, { sid: "-" });
  else if (session.ok) {
    noteFacts(facts, { sid: session.id });
    parts.collector.clicked(session.id);
  }
  // [LAW:single-enforcer] Held through its turn, so its waits ask the host
  // whether its client left, by its id.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- held for its disposal
  using _held = parts.clicks.hold(click);
  const delivered = await parts.renderer.answer({
    kind: "event",
    at: instantAt(parts.clock),
    event: {
      kind: "click",
      verb,
      value,
      session,
      arrival,
      id: click.id,
      latest: session?.ok ? parts.frameFeeds.latest(session.id) : null,
    },
  });
  switch (delivered.kind) {
    case "answered":
      facts.push(...delivered.record);
      return { kind: "ok" };
    case "threw":
      facts.push(...delivered.record);
      return delivered.failure;
  }
}

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

const cliAnswer = (taken: Taken): Response => clickReply(outcomeOf(taken));

// [LAW:dataflow-not-control-flow] What the URL handler is told, by what the
// host did with its click: a refusal, and a turn no renderer was there to
// take, are failures the app shows; any turn a renderer took is delivered,
// since what went wrong in it is held on the bar.
const UNTAKEN: ReadonlySet<RequestOutcome["kind"]> = new Set([
  "closing",
  "abandoned",
  "down",
]);
function forwarderAnswer(taken: Taken): Response {
  const outcome = outcomeOf(taken);
  return taken.kind === "refused" || UNTAKEN.has(outcome.kind)
    ? clickReply(outcome)
    : { ok: true, output: "" };
}

// A click in a tmux status line: the link the daemon's frame marks that range
// with, run as a click on it in the bar would run — a `cc-candybar://` link
// through its own verb, any other through the platform's opener. Its verb
// is told the click came through tmux, not the URL handler.
async function statusLineClick(
  parts: DaemonParts,
  value: string,
  facts: RequestFacts,
  click: ClickInFlight,
): Promise<Taken> {
  const { tmuxStatusLines } = parts;
  const link = tmuxStatusLines.linkAt(value);
  if (link.kind === "refused") return refused(badRequest(link.reason));
  noteFacts(facts, { link: link.url });
  if (isBarLink(link.url)) {
    const parsed = parseClick(link.url, parts.links);
    switch (parsed.kind) {
      case "refused":
        return refused(badRequest(parsed.problem));
      // [LAW:no-silent-failure] A link the bar draws never names a range;
      // one that did would be a click that only ever clicks another.
      case "range":
        return refused(
          badRequest("a status-line link names another status-line click"),
        );
      case "link":
        return handed(
          await clickRan(() =>
            handleClick(
              parts,
              parsed.verb,
              parsed.value,
              { via: "tmux-status" },
              facts,
              click,
            ),
          ),
        );
    }
  }
  return handed(
    await clickRan(async () => {
      await clickHandoff(
        parts.launcher,
        {
          bin: process.platform === "darwin" ? "/usr/bin/open" : "xdg-open",
          args: [link.url],
          category: "click.open",
        },
        `opening ${link.url}`,
        parts.log,
        CLICK_PROGRAM_TIMEOUT_MS,
        parts.tmp,
      );
      return { kind: "ok" };
    }),
  );
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
