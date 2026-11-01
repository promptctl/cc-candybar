// A daemon's answer to a request: the checkpoint, then a reply per kind.

import process from "node:process";
import { inspect } from "node:util";
import type { DaemonParts } from "./daemon-parts.js";
import { answerRequest, NOTHING_DELIVERED, renderFailed } from "./draw-bar.js";
import {
  checkRenderRequest,
  type CheckedRenderRequest,
} from "./render-checkpoint.js";
import { PROTOCOL_VERSION, sanitizeClientVersion } from "./protocol";
import type {
  ClickRequest,
  Request,
  Response,
  SubscribeRequest,
} from "./protocol";
import { parseSessionId, type SessionId } from "./session-id";
import { type SourceSnapshots } from "./stats";
import { VERBS, clickLaunch, clickSessionOf, BadVerbArgs } from "./verbs";
import { ClickAbandoned, DaemonClosing } from "./verb-error";
import { transcriptReads } from "../utils/transcript-fs.js";
import { readStores } from "../doctor/edge";
import type { ClickArrival } from "../doctor/sightings";
import { transcriptSaid, type FrameSeen } from "./render-sightings";
import { claudeConfigDir } from "../claude-settings";
import { decodeWire } from "./verb-error";
import { buildDebugSnapshot } from "./debug";
import { DEBUG_WHATS, isDebugWhat } from "./debug-types";
import {
  renderStripCells,
  type BuildLineOptions,
  type ColorCompatibility,
} from "../render/strip.js";
import { floorOf } from "../config/globals-fields.js";
import type { RichText } from "@promptctl/rich-js";
import { LANE_NAMES, parseLane, type Lane } from "../config/lanes.js";
import { answeredClickError } from "./click-error.js";
import { VERB_TMUX_STATUS_CLICK } from "../click/wire.js";
import { parseHandlerUrl } from "../install/index.js";
import { instantOf } from "../utils/instant.js";
import { waitBudgetMs } from "./request-deadline.js";
import {
  noteFacts,
  requestEvent,
  type RequestFacts,
  type RequestOutcome,
} from "./request-event.js";

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
  // [LAW:effects-at-boundaries] What the reply's sender records once the
  // client holds the response — only the connection knows when that is: a
  // render whose answer carried a click error marks it answered.
  readonly delivered: () => void;
}
// A subscription is the one request answered by a stream rather than a reply:
// the connection boundary turns its socket over to the session's feed.
export type HandledRequest =
  | ({ kind: "reply" } & Reply)
  | { kind: "subscribe"; sessionId: SessionId; lane: Lane };

const stay = (resp: Response): Reply => ({
  resp,
  exitAfterFlush: null,
  delivered: NOTHING_DELIVERED,
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
  req: Request,
  timedOut: () => boolean,
  accepted: number,
  clientLeft: () => boolean,
): Promise<HandledRequest> {
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
      delivered: NOTHING_DELIVERED,
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
  accepted: number,
  clientLeft: () => boolean,
): Promise<Reply> {
  const {
    stats,
    clock,
    frameFeeds,
    renderCache,
    payloadProviders: { gitProvider, usageStore },
    fileEvents,
    runs,
    effectSessions,
    menuIdle,
    journalTurns,
    sessionState,
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
      delivered: NOTHING_DELIVERED,
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
    return stay({
      ok: true,
      stats: stats.snapshot({
        gitCache: gitProvider.getStats(),
        usageCache: usageStore.getStats(),
        sources: sourceSnapshots(parts),
        fileEvents: fileEvents.stats(),
        runs: runs.stats(),
        transcriptReads: transcriptReads(),
        renderCache: renderCache.stats,
        effectCache: effectSessions.getStats(),
        menuIdle: menuIdle.getStats(),
        journalTurns: journalTurns.getStats(),
        sessionState: {
          sessions: sessionState.size(),
          observers: sessionState.observers(),
          revision: sessionState.latestRevision(),
        },
        frameFeeds: frameFeeds.getStats(),
        tmuxStatus: tmuxStatusLines.stats(),
        watchersActive: watcherRegistry.size(),
        dirWatchesActive: watcherRegistry.dirWatches(),
        nextRestartReason: limits.describeNextRestart(),
        handlerProbes: handlerProbes.list(),
        clients: renderSightings.list(instantOf(clock.date())),
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
    const started = clock.date();
    const at = instantOf(started);
    const t0 = clock.monotonic();
    const queuedMs = Math.round(t0 - accepted);
    // [LAW:nothing-unseen] One render event per render request, written here
    // on every exit — a refusal and a throw included — from the facts the
    // render reached, so a failing render is described like any other.
    // A throw is this request's own RENDER_FAILED reply, so the event is the
    // one record of it and the connection's catch never sees a render.
    const facts: RequestFacts = [];
    // Where this request came in the order they arrived: renders of one session
    // can finish out of it.
    // [LAW:one-source-of-truth] The count of render requests received is that
    // order.
    const order = ++stats.requestsTotal;
    const checked = checkRenderRequest(req, stats, parts.log);
    // [LAW:single-enforcer] A render REQUEST is a client sighting — the
    // frames a feed draws from a session's data are not, so this is the one
    // write, here rather than in drawRender. It is written as the request
    // arrives, `drawing`, and again once its render settles, carrying what the
    // frame drew — both stamped with the instant and order it arrived in.
    const sighted = (req: CheckedRenderRequest, frame: FrameSeen): void =>
      renderSightings.see(
        req.sessionId,
        {
          client: req.hints.client ?? null,
          termCols: req.hints.termCols ?? null,
          rateLimits: req.rateLimits,
          claudeConfigDir: claudeConfigDir(req.hints.claudeConfigDir),
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
      // own client's, drawn for a request and never pushed, and its `encoding`
      // says how that answer is spelled and reaches no feed
      // (src/daemon/frame-feed.ts).
      frameFeeds.note(checked.req.sessionId, checked.req, order);
    }
    const rendered: {
      outcome: RequestOutcome;
      resp: Response;
      delivered: () => void;
    } = !checked.ok
      ? refusedRender(checked.problems)
      : await answerRequest(
          parts,
          checked.req,
          at,
          // [LAW:no-ambient-temporal-coupling] When the request's wait ends,
          // fixed at its arrival: early enough before its client hangs up to
          // draw (src/daemon/request-deadline.ts).
          t0 +
            waitBudgetMs(checked.req.deadline, accepted, {
              epochMs: started.getTime(),
              monoMs: t0,
            }),
          facts,
        ).then(
          ({ resp, motion, clickShown, delivered }) => {
            sighted(checked.req, motion);
            return {
              outcome: { kind: "ok" } as const,
              resp,
              // [LAW:single-enforcer] An answer carrying the click error that
              // reaches its client is the one that delivered it
              // (src/daemon/click-error.ts).
              delivered: () => {
                delivered();
                if (clickShown !== null)
                  answeredClickError(
                    sessionState,
                    checked.req.sessionId,
                    clickShown,
                  );
              },
            };
          },
          (error: unknown) => {
            sighted(checked.req, "failed");
            return {
              outcome: { kind: "threw", error } as const,
              resp: renderFailed(error),
              delivered: NOTHING_DELIVERED,
            };
          },
        );
    if (rendered.outcome.kind !== "ok") stats.requestsErrored++;
    // Whether the client was already told TIMEOUT while this render ran on,
    // and how long the request was queued, from the connection's accept,
    // before it began: the daemon's own delay and the client's sending of its
    // frame both count, so a round trip longer than `took` is time spent
    // there.
    noteFacts(facts, {
      timedOut: timedOut() ? "Y" : "N",
      clientLeft: clientLeft() ? "Y" : "N",
      queued: `${queuedMs}ms`,
    });
    const { level, line } = requestEvent(
      "render",
      facts,
      rendered.outcome,
      Math.round(clock.monotonic() - t0),
    );
    parts.log(level, line);
    return {
      resp: rendered.resp,
      exitAfterFlush: null,
      delivered: rendered.delivered,
    };
  }

  if (req.kind === "click") {
    // [LAW:nothing-unseen] One click event per click request, whatever its
    // outcome: how long it was queued behind the loop from its accept, how
    // long it then took, and what it learned on the way (a status-line
    // click's link, the verb that ran, its session). A field absent means it
    // stopped before it.
    const t0 = clock.monotonic();
    const facts: RequestFacts = [["queued", `${Math.round(t0 - accepted)}ms`]];
    const outcome = await clickOutcome(
      parts,
      req,
      facts,
      () => timedOut() || clientLeft(),
    );
    // Whether the client was told TIMEOUT, and whether it hung up, while the
    // click ran: its effect lands though the client reported a failure. One
    // still waiting for its turn at either moment was refused (`abandoned`).
    noteFacts(facts, {
      timedOut: timedOut() ? "Y" : "N",
      clientLeft: clientLeft() ? "Y" : "N",
    });
    const { level, line } = requestEvent(
      "click",
      facts,
      outcome,
      Math.round(clock.monotonic() - t0),
    );
    parts.log(level, line);
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
        // in src/daemon/verbs/state-validators.ts.
        error: `unknown debug 'what': ${String(req.what)} (have: ${DEBUG_WHATS.join(", ")})`,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
    }
    // [LAW:dataflow-not-control-flow] The debug projection samples whatever
    // DSL state the cache currently holds. With cache keys scoped on
    // (projectDir, cwd) and the debug request carrying neither, we sample
    // the most recently rendered session's view — sufficient for `debug vars`,
    // `debug segments`, `debug config` against the active workload.
    // latestView reads existing views only; it does NOT open one,
    // so debug introspection never has the side effect of standing up a new
    // (projectDir=undefined) cache entry tied to the daemon's own
    // process.cwd(). A future debug-target selector would thread (session,
    // projectDir, cwd) through the wire.
    const dbgView = renderCache.latestView();
    // [LAW:dataflow-not-control-flow] Lazy per-segment serialization: the
    // cache stores StripCell arrays (cheap, written by renderDsl).
    // The debug projection needs strings, so serialize only for the
    // `segments` projection (`vars` and `config` don't need it) and only
    // when this request actually fires. Normal renders pay no per-segment
    // serializer cost — that work shifts to debug-request time, which is
    // operator-driven and rare.
    const dbgState =
      dbgView === null
        ? null
        : {
            store: dbgView.store,
            registry: dbgView.registry,
            config: dbgView.state.config,
            compiled: dbgView.state.compiled,
            lastRenderBySegment:
              req.what === "segments"
                ? serializeSegmentCells(
                    dbgView.lastRenderCellsBySegment,
                    dbgView.state.config.globals.colorCompatibility ??
                      floorOf("colorCompatibility"),
                  )
                : EMPTY_RENDER_MAP,
          };
    return stay({ ok: true, debug: buildDebugSnapshot(req.what, dbgState) });
  }

  const unanswered: never = req;
  throw new Error(`no reply for request ${inspect(unanswered)}`);
}

// [LAW:nothing-unseen] Every source's refreshes from the one ledger, beside
// how many homes of each scope the owners keep and how many a view holds.
function sourceSnapshots(parts: DaemonParts): SourceSnapshots {
  const {
    payloadProviders: {
      gitProvider,
      tmuxService,
      usageStore,
      managedStorage,
      hostService,
    },
    renderCache,
    refreshLedger,
  } = parts;
  const git = gitProvider.getStats();
  const tmux = tmuxService.getStats();
  const today = usageStore.scanStats();
  const storage = managedStorage.stats();
  const cache = renderCache.stats;
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

// [LAW:single-enforcer] Style + color compatibility shared by the render
// path and the lazy debug-side per-segment serializer. Per-request `width`
// is composed on top at the wire boundary (replyTo's render arm) and
// passed through as renderOpts. Debug serialization composes its own
// per-segment opts with width: Number.POSITIVE_INFINITY since each segment
// is rendered standalone (wrap doesn't apply to a one-segment projection).
const RENDER_OPTS_BASE = {
  endcaps: floorOf("endcaps"),
  colorCompatibility: floorOf("colorCompatibility"),
  wrap: floorOf("autoWrap"),
  padding: floorOf("padding"),
};
const DEBUG_RENDER_OPTS: BuildLineOptions = {
  ...RENDER_OPTS_BASE,
  width: Number.POSITIVE_INFINITY,
};

// [LAW:no-defensive-null-guards] Reused empty map for the `vars` /
// `config` debug projections — they don't read lastRenderBySegment but
// the DaemonDslState type requires the field.
const EMPTY_RENDER_MAP = new Map<string, string>();

// [LAW:one-source-of-truth] The color depth is a serialization-time choice.
// A debug request carries no session, so the sampled entry's CONFIG values
// are the ones it can state — a session's own pick, like its endcaps, is not
// visible here. The caller threads the entry-resolved values; this
// serializer never re-defaults them.
function serializeSegmentCells(
  cells: ReadonlyMap<string, readonly RichText[]>,
  colorCompatibility: ColorCompatibility,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, segCells] of cells) {
    out.set(
      name,
      renderStripCells(segCells, {
        ...DEBUG_RENDER_OPTS,
        colorCompatibility,
      }),
    );
  }
  return out;
}

// [LAW:parse-dont-validate][LAW:no-silent-failure] A click request run to its
// outcome. Its verb and value are untrusted JSON, refused here unless both are
// strings, and whatever the click then throws is its outcome too, so every
// click writes its event: a refusal of its arguments is a bad request, and
// anything else thrown is the daemon's failure — a program the click ran, or
// a bug — recorded with the stack that says which.
async function clickOutcome(
  parts: DaemonParts,
  req: ClickRequest,
  facts: RequestFacts,
  clientGone: () => boolean,
): Promise<RequestOutcome> {
  const { verb, value } = req as { verb: unknown; value: unknown };
  if (typeof verb !== "string" || typeof value !== "string") {
    return {
      kind: "bad-request",
      problems: [
        `a click's verb and value are strings, got ${typeof verb} and ${typeof value}`,
      ],
    };
  }
  try {
    return await handleClick(
      parts,
      verb,
      value,
      { via: "link", handler: sanitizeClientVersion(req.clientVersion) },
      facts,
      clientGone,
    );
  } catch (error) {
    if (error instanceof BadVerbArgs)
      return { kind: "bad-request", problems: [error.message] };
    if (error instanceof DaemonClosing) return { kind: "closing", error };
    if (error instanceof ClickAbandoned) return { kind: "abandoned", error };
    return { kind: "threw", error };
  }
}

// [LAW:dataflow-not-control-flow] The dispatcher is a table lookup. The verb
// table (src/daemon/verbs/index.ts) is the single canonical list of supported
// verbs — handlers live there, the dispatcher only routes.
//
// [LAW:types-are-the-program] The error class on the throw determines the
// response code: BadVerbArgs (invalid input shape) becomes BAD_REQUEST; any
// other Error (operational failure) becomes RENDER_FAILED. No string matching.

// [LAW:dataflow-not-control-flow] The field a click records the verb it runs
// under, by how it arrived: a status-line click has already recorded its own
// verb, so the one its link runs is `linkVerb`.
const VERB_FACT: Readonly<Record<ClickArrival["via"], string>> = {
  link: "verb",
  "tmux-status": "linkVerb",
};

async function handleClick(
  parts: DaemonParts,
  verb: string,
  value: string,
  arrival: ClickArrival,
  facts: RequestFacts,
  clientGone: () => boolean,
): Promise<RequestOutcome> {
  const { menuIdle, verbCtx } = parts;
  if (verb === VERB_TMUX_STATUS_CLICK) {
    noteFacts(facts, { verb });
    return statusLineClick(parts, value, facts, clientGone);
  }
  const handler = VERBS.get(verb);
  if (!handler) {
    return { kind: "bad-request", problems: [`unknown click verb: ${verb}`] };
  }
  noteFacts(facts, { [VERB_FACT[arrival.via]]: verb });
  // The click's session, as it crossed the one session-id checkpoint: one
  // that passed is recorded and is pending on its idle clock until it settles,
  // one that failed is never recorded, and a click naming none records `sid=-`.
  const session = clickSessionOf(verb, value);
  const pending = session?.ok ? session.id : null;
  if (session === null) noteFacts(facts, { sid: "-" });
  else if (pending !== null) {
    noteFacts(facts, { sid: pending });
    menuIdle.clickArrived(pending);
  }
  try {
    await handler(value, {
      ...verbCtx,
      arrival,
      placeWaited: (ms) => noteFacts(facts, { placeWait: `${ms}ms` }),
      gatherTook: (ms) => noteFacts(facts, { gather: `${ms}ms` }),
      turnWaited: (ms) => noteFacts(facts, { turnWait: `${ms}ms` }),
      clientGone,
    });
  } finally {
    if (pending !== null) menuIdle.clickSettled(pending);
  }
  return { kind: "ok" };
}

// [LAW:single-enforcer] The reply a click's outcome is answered with.
function clickReply(outcome: RequestOutcome): Response {
  switch (outcome.kind) {
    case "ok":
      return { ok: true, output: "" };
    case "bad-request":
      return {
        ok: false,
        error: outcome.problems.join("; "),
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      };
    case "threw":
    case "closing":
    case "abandoned":
      return renderFailed(outcome.error);
  }
}

// A click in a tmux status line: the link the daemon's frame marks that range
// with, run as a click on it in the bar would run — a `cc-candybar://` link
// through its own verb, any other through the platform's opener. Its verb
// is told the click came through tmux, not the URL handler.
async function statusLineClick(
  parts: DaemonParts,
  value: string,
  facts: RequestFacts,
  clientGone: () => boolean,
): Promise<RequestOutcome> {
  const { tmuxStatusLines } = parts;
  const refused = (problem: string): RequestOutcome => ({
    kind: "bad-request",
    problems: [problem],
  });
  const click = tmuxStatusLines.linkAt(value);
  if (click.kind === "refused") return refused(click.reason);
  noteFacts(facts, { link: click.url });
  if (click.url.startsWith("cc-candybar://")) {
    // A link a config wrote with a malformed escape is refused, as any
    // click's malformed wire encoding is.
    const parsed = decodeWire(() => parseHandlerUrl(click.url));
    // [LAW:no-silent-failure] A link the bar draws never names this verb; one
    // that did would be a click that only ever clicks another.
    if (parsed.verb === VERB_TMUX_STATUS_CLICK)
      return refused("a status-line link names another status-line click");
    return handleClick(
      parts,
      parsed.verb,
      parsed.value,
      { via: "tmux-status" },
      facts,
      clientGone,
    );
  }
  await clickLaunch(
    parts.launcher,
    {
      bin: process.platform === "darwin" ? "/usr/bin/open" : "xdg-open",
      args: [click.url],
      category: "click.open",
    },
    `opening ${click.url}`,
    parts.log,
  );
  return { kind: "ok" };
}

// The answer to a request the checkpoint refused.
const refusedRender = (problems: string[]) => ({
  outcome: { kind: "bad-request", problems } as const,
  resp: {
    ok: false,
    error: `malformed hookData: ${problems.join("; ")}`,
    code: "BAD_REQUEST",
    daemonV: PROTOCOL_VERSION,
  } satisfies Response,
  delivered: NOTHING_DELIVERED,
});
