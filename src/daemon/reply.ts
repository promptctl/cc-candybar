// A daemon's answer to a request: the checkpoint, then a reply per kind.

import { isAbsolute } from "node:path";
import process from "node:process";
import { inspect } from "node:util";
import type { DaemonParts } from "./daemon-parts.js";
import type { DaemonLogger } from "../utils/logger";
import { apply, applyRequest, applyUnanswered } from "./apply.js";
import { NOTHING_DELIVERED, renderFailed } from "./draw-bar.js";
import {
  checkRenderRequest,
  type CheckedRenderRequest,
} from "./render-checkpoint.js";
import {
  parseRecordSeconds,
  PROTOCOL_VERSION,
  URL_FRAME_VERSIONS,
} from "./protocol";
import type {
  ClickRequest,
  Inbound,
  Request,
  Response,
  RecordRequest,
  SubscribeRequest,
} from "./protocol";
import { parseSessionId, type SessionId } from "./session-id";
import { RecordingFailed, recordToFile } from "./session-recorder.js";
import { type SourceSnapshots } from "./stats";
import {
  CLICK_PROGRAM_TIMEOUT_MS,
  clickHandoff,
  clickSession,
  readClick,
  BadVerbArgs,
} from "./verbs";
import { ClickAbandoned, DaemonClosing } from "./verb-error";
import { elapsedMs, plusMs, spanMs, type Monotonic } from "../time.js";
import { transcriptReads } from "../utils/transcript-fs.js";
import { readStores } from "../doctor/edge";
import type { ClickArrival } from "../doctor/sightings";
import { transcriptSaid, type FrameSeen } from "./render-sightings";
import { claudeConfigDir } from "../claude-settings";
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
import { isBarLink } from "../click/scheme.js";
import { parseHandlerUrl, VERB_RANGE } from "../click/wire.js";
import { instantOf } from "../utils/instant.js";
import { waitBudgetMs } from "./request-deadline.js";
import { runsNowIn } from "./session-pane.js";
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
// the connection boundary turns its socket over to the session's feed. A held
// request is answered past the request backstop by design (a recording,
// answered when its file closes).
// [LAW:effects-at-boundaries] Held work is a description: the connection
// starts it only once it knows a client still waits for the answer, so a
// request the backstop already answered starts nothing, and `left` aborts
// when that client hangs up, so its work stops with it.
export type HandledRequest =
  | ({ kind: "reply" } & Reply)
  | { kind: "subscribe"; sessionId: SessionId; lane: Lane }
  | { kind: "held"; start: (left: AbortSignal) => Promise<Reply> };

// A reply that leaves the daemon up and delivers nothing.
export const stay = (resp: Response): Reply => ({
  resp,
  exitAfterFlush: null,
  delivered: NOTHING_DELIVERED,
});
export const replied = (reply: Reply): HandledRequest => ({
  kind: "reply",
  ...reply,
});

// [LAW:types-are-the-program] Every request kind answered with a reply: all
// but a subscribe and a record, the compiler naming one added to the protocol
// until it is.
export type ReplyRequest = Exclude<Request, SubscribeRequest | RecordRequest>;
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

// [LAW:parse-dont-validate] A record request's fields, parsed once: the
// session, an absolute path (a relative one would resolve against the
// daemon's own directory, which is no client's), and a positive span.
export function parseRecordRequest(req: RecordRequest):
  | {
      readonly ok: true;
      readonly session: SessionId;
      readonly path: string;
      readonly seconds: number;
    }
  | { readonly ok: false; readonly problem: string } {
  const { session, path, seconds } = req as {
    session: unknown;
    path: unknown;
    seconds: unknown;
  };
  const id = parseSessionId(session);
  if (!id.ok) return { ok: false, problem: `record's session ${id.problem}` };
  if (typeof path !== "string" || !isAbsolute(path)) {
    return {
      ok: false,
      problem: `record's path is not an absolute path: ${JSON.stringify(path)}`,
    };
  }
  const span = parseRecordSeconds(seconds);
  if (!span.ok) {
    return {
      ok: false,
      problem: `record's seconds ${JSON.stringify(seconds)} ${span.problem}`,
    };
  }
  return { ok: true, session: id.id, path, seconds: span.seconds };
}

// A record request past the connection's checkpoint: the recording it starts
// once the connection knows a client waits, answered when its file closes, or
// the reply refusing it. A recording that cannot start or that a write ends
// is answered with why.
function recording(parts: DaemonParts, req: RecordRequest): HandledRequest {
  const parsed = parseRecordRequest(req);
  if (!parsed.ok) return refuse("BAD_REQUEST", parsed.problem);
  const { session, path, seconds } = parsed;
  return {
    kind: "held",
    start: (left) =>
      recordToFile(
        parts.recorder,
        parts.clock,
        session,
        path,
        seconds,
        left,
      ).then(
        (recorded) => stay({ ok: true, recorded }),
        (e: unknown) =>
          stay({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            // [LAW:types-are-the-program] A recording a write ended is the
            // daemon failing; one refused before it began, the request.
            code:
              e instanceof RecordingFailed ? "RENDER_FAILED" : "BAD_REQUEST",
            daemonV: PROTOCOL_VERSION,
          }),
      ),
  };
}

// [LAW:single-enforcer] The protocol-version gate: the reply to a request at
// another version, or null for one this daemon speaks. It reads nothing of
// the daemon but its log and the version it speaks, so it is judged apart
// from every other part.
export function versionGate(
  req: Request,
  log: DaemonLogger,
  daemonV: number,
): HandledRequest | null {
  if (req.v === daemonV) return null;
  // [LAW:types-are-the-program] The asymmetry is data, not control flow.
  //   client > daemon: the *binary* probably upgraded under us. Exit so the
  //     next client respawns from the current artifact.
  //   client < daemon: the *client* is stale. Respawning daemon does not
  //     help (the new daemon will have the same version). Stay up and
  //     return VERSION_MISMATCH — the client is responsible for surfacing
  //     the diagnostic and refusing to kick. Shutting down here was the
  //     load-bearing half of the 452-corpse spiral (kz8.5).
  if (req.v > daemonV) {
    log(
      "info",
      `version mismatch: client=${req.v} > daemon=${daemonV}; binary likely upgraded — exiting after the response flushes`,
    );
  } else {
    log(
      "info",
      `version mismatch: client=${req.v} < daemon=${daemonV}; client is stale — staying up`,
    );
  }
  return {
    kind: "reply",
    resp: {
      ok: false,
      error: `protocol v${req.v} not supported (daemon at v${daemonV})`,
      code: "VERSION_MISMATCH",
      daemonV,
    },
    // [LAW:dataflow-not-control-flow] The asymmetry above is this value.
    // Exit is sequenced on the response flush, so the client always sees
    // the VERSION_MISMATCH diagnostic — never a dead socket.
    exitAfterFlush: req.v > daemonV ? 0 : null,
    delivered: NOTHING_DELIVERED,
  };
}

export async function handleRequest(
  parts: DaemonParts,
  inbound: Inbound,
  timedOut: () => boolean,
  accepted: Monotonic,
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

  const mismatch = versionGate(req, parts.log, PROTOCOL_VERSION);
  if (mismatch !== null) return mismatch;

  if (req.kind === "subscribe") return subscription(req);
  if (req.kind === "record") return recording(parts, req);
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
  accepted: Monotonic,
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
    sourceRuns,
    effectSessions,
    menuIdle,
    journalTurns,
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
        runsNowIn({ socket, pane }, parts.heldSession),
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
        sourceRuns: sourceRuns.stats(),
        runs: runs.stats(),
        transcriptReads: transcriptReads(),
        renderCache: renderCache.stats,
        effectCache: effectSessions.getStats(),
        menuIdle: menuIdle.getStats(),
        journalTurns: journalTurns.getStats(),
        sessionState: {
          sessions: parts.sessionState.size(),
          observers: parts.sessionState.observers(),
          revision: parts.sessionState.latestRevision(),
        },
        frameFeeds: frameFeeds.getStats(),
        tmuxStatus: tmuxStatusLines.stats(),
        linkIds: parts.linkIds.stats(),
        watchersActive: watcherRegistry.size(),
        dirWatchesActive: watcherRegistry.dirWatches(),
        dirsPolled: watcherRegistry.polledDirs(),
        nextRestartReason: limits.describeNextRestart(),
        handlerProbes: handlerProbes.list(),
        clients: renderSightings.list(instantOf(new Date(clock.now()))),
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
    const queuedMs = spanMs(accepted, t0);
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
    const checked = checkRenderRequest(
      req,
      stats,
      parts.log,
      parts.home,
      parts.storedRoot,
      parts.heldSession,
    );
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
      // [LAW:nothing-unseen] The session, first on the request's line once
      // it passed the checkpoint, so a request refused at its turn names it.
      noteFacts(facts, { sid: checked.req.sessionId });
      sighted(checked.req, "drawing");
      // [LAW:one-source-of-truth] A request past the checkpoint is the
      // session's data from now on; a followed session's next frame is drawn
      // from it, brought forward as its view takes it up. Its answer is its
      // own client's, drawn for a request and never pushed: its `encoding`
      // says how that answer is spelled, and no feed reads it
      // (src/daemon/frame-feed.ts).
      frameFeeds.note(checked.req.sessionId, checked.req, order);
    }
    const rendered: {
      outcome: RequestOutcome;
      resp: Response;
      delivered: () => void;
    } = !checked.ok
      ? refusedRender(checked.problems)
      : await applyRequest(
          {
            kind: "request",
            req: checked.req,
            at,
            arrived: accepted,
            // [LAW:no-ambient-temporal-coupling] When the request's wait ends,
            // fixed at its arrival: early enough before its client hangs up to
            // draw (src/daemon/request-deadline.ts).
            waitEndsAt: plusMs(
              t0,
              waitBudgetMs(checked.req.deadline, accepted, {
                epochMs: started.getTime(),
                monoMs: t0,
              }),
            ),
            facts,
          },
          parts,
        ).then(
          ({ resp, motion, answersClick, pipeShown, delivered }) => {
            sighted(checked.req, motion);
            return {
              outcome: { kind: "ok" } as const,
              resp,
              // [LAW:single-enforcer] An answer carrying the click error or the
              // launcher's pipe event that reaches its client is the one that
              // delivered it (src/utils/event-hold.ts). The click error's mark
              // is a write, so it is an event the arm makes in a turn.
              delivered: () => {
                delivered();
                if (answersClick.length > 0)
                  void applyUnanswered(
                    {
                      kind: "answered",
                      session: checked.req.sessionId,
                      errors: answersClick,
                    },
                    parts,
                    `sid=${checked.req.sessionId}`,
                  );
                // Daemon-wide: one session's answer having shown the
                // launcher's pipe event is what makes it not silent.
                if (pipeShown !== null)
                  parts.launcher.answeredPipeEvent(pipeShown);
              },
            };
          },
          (error: unknown) => {
            sighted(checked.req, "failed");
            return {
              outcome: daemonOutcome(error),
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
      elapsedMs(clock, t0),
    );
    parts.log(level, line);
    return {
      resp: rendered.resp,
      exitAfterFlush: null,
      delivered: rendered.delivered,
    };
  }

  if (req.kind === "click") {
    return stay(
      await clickEvent(parts, accepted, timedOut, clientLeft, (facts, gone) =>
        clickOutcome(parts, req, facts, gone),
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
    // cache stores StripCell arrays (cheap, written by drawDsl).
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

// [LAW:nothing-unseen][LAW:single-enforcer] One click event per click,
// however it arrived (a `click` request, the URL handler's frame), whatever
// its outcome: how long it was queued behind the loop from its accept, how
// long it then took, and what it learned on the way (who delivered it, a
// status-line click's link, the verb that ran, its session). A field absent
// means it stopped before it.
async function clickEvent(
  parts: DaemonParts,
  accepted: Monotonic,
  timedOut: () => boolean,
  clientLeft: () => boolean,
  run: (facts: RequestFacts, gone: () => boolean) => Promise<RequestOutcome>,
): Promise<Response> {
  const { clock } = parts;
  const t0 = clock.monotonic();
  const facts: RequestFacts = [["queued", `${spanMs(accepted, t0)}ms`]];
  // When a click is refused before it runs: the daemon's deadline passed, or
  // a client that waited for the answer left, while it sat behind the loop. The connection knows which
  // clients wait (the forwarder does not), so its `clientLeft` already says so.
  const gone = () => timedOut() || clientLeft();
  const outcome = await run(facts, gone);
  // Whether the client was told TIMEOUT, and whether a client that waited
  // hung up, while the click ran: its effect lands though the client reported
  // a failure. One that had not run yet at either moment was refused
  // (`abandoned`).
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
// outcome. Its link is untrusted JSON, refused here unless it is a string, and
// whatever the click then throws is its outcome too, so every click writes its
// event: a refusal of its link is a bad request, and anything else thrown is
// the daemon's failure — a program the click ran, or a bug — recorded with the
// stack that says which.
async function clickOutcome(
  parts: DaemonParts,
  req: ClickRequest,
  facts: RequestFacts,
  gone: () => boolean,
): Promise<RequestOutcome> {
  const arrival: ClickArrival = { via: "link", delivery: { kind: "cli" } };
  noteFacts(facts, { via: "cli" });
  const { url } = req as { url: unknown };
  if (typeof url !== "string") {
    return {
      kind: "bad-request",
      problems: [`a click's link is a string, got ${typeof url}`],
    };
  }
  return clickRan(() => linkClick(parts, url, arrival, facts, gone));
}

// [LAW:parse-dont-validate][LAW:no-silent-failure] The URL handler's frame run
// to its outcome. The app forwards the link raw and reads no answer, so this
// event is the only place its click is seen: a frame of a version the daemon
// does not speak, a link of another scheme, or a malformed verb is refused
// here, as a bad request on the event, never dropped.
async function urlClick(
  parts: DaemonParts,
  frame: Record<string, unknown>,
  timedOut: () => boolean,
  accepted: Monotonic,
  clientLeft: () => boolean,
): Promise<Response> {
  return clickEvent(
    parts,
    accepted,
    timedOut,
    clientLeft,
    async (facts, gone) => {
      const { urlV, url } = frame;
      noteFacts(facts, { via: "forwarder", urlV: String(urlV) });
      if (typeof urlV !== "number" || !URL_FRAME_VERSIONS.has(urlV)) {
        return {
          kind: "bad-request",
          problems: [
            `the URL handler's frame version ${inspect(urlV)} is not one this daemon speaks (${[...URL_FRAME_VERSIONS].join(", ")})`,
          ],
        };
      }
      if (typeof url !== "string") {
        return {
          kind: "bad-request",
          problems: [`the URL handler's frame carries no url string`],
        };
      }
      const arrival: ClickArrival = {
        via: "link",
        delivery: { kind: "forwarder", urlV },
      };
      return clickRan(() => linkClick(parts, url, arrival, facts, gone));
    },
  );
}

// What a click that reached its verb became: whatever it throws is its
// outcome, so every click writes its event.
async function clickRan(
  click: () => Promise<RequestOutcome>,
): Promise<RequestOutcome> {
  try {
    return await click();
  } catch (error) {
    return thrownOutcome(error);
  }
}

// What a click whose verb threw became: a refusal of its arguments is the
// client's, and one whose client left is abandoned. Anything else is the
// daemon's, as a render's is.
function thrownOutcome(error: unknown): RequestOutcome {
  if (error instanceof BadVerbArgs)
    return { kind: "bad-request", problems: [error.message] };
  if (error instanceof ClickAbandoned) return { kind: "abandoned", error };
  return daemonOutcome(error);
}

// [LAW:single-enforcer] What a request's work that threw became, for a
// render as for a click: the daemon's close refusing it is `closing`, and
// anything else is the daemon's failure.
function daemonOutcome(error: unknown): RequestOutcome {
  return error instanceof DaemonClosing
    ? { kind: "closing", error }
    : { kind: "threw", error };
}

// [LAW:dataflow-not-control-flow] The dispatcher is a table lookup. The wire's
// link verbs (src/click/wire.ts) are the single canonical list of what a link
// may name: a status-line range is routed here, and every other click is read
// by the daemon's click readers (src/daemon/verbs/index.ts), where its
// handlers live — the dispatcher only routes.
//
// [LAW:types-are-the-program] The error class on the throw determines the
// response code: BadVerbArgs (invalid input shape) becomes BAD_REQUEST; any
// other Error (operational failure) becomes RENDER_FAILED. No string matching.

// [LAW:dataflow-not-control-flow] The fields a click records its link's
// address and the verb it runs under, by how it arrived: a status-line click
// has already recorded its own, so the ones the link its range marks carries
// are `linkTo` and `linkVerb`.
const TO_FACT: Readonly<Record<ClickArrival["via"], string>> = {
  link: "to",
  "tmux-status": "linkTo",
};
const VERB_FACT: Readonly<Record<ClickArrival["via"], string>> = {
  link: "verb",
  "tmux-status": "linkVerb",
};

// [LAW:single-enforcer] Every link a click carries, however it arrived (the
// URL handler's frame, url-handle's request, a tmux status range): read by
// the one link parse, its address recorded, and judged here, the one place a
// link's address meets this renderer's name. A link named for another
// renderer reached the wrong socket, so it is refused rather than run on
// state it was never drawn from.
async function linkClick(
  parts: DaemonParts,
  url: string,
  arrival: ClickArrival,
  facts: RequestFacts,
  clientGone: () => boolean,
): Promise<RequestOutcome> {
  const link = parseHandlerUrl(url);
  if (!link.ok) return { kind: "bad-request", problems: [link.problem] };
  noteFacts(facts, { [TO_FACT[arrival.via]]: link.to });
  const own = parts.links.to;
  if (link.to !== own) {
    return {
      kind: "bad-request",
      problems: [
        `the link is addressed to renderer ${JSON.stringify(link.to)}, and this is ${JSON.stringify(own)}`,
      ],
    };
  }
  return handleClick(parts, link.verb, link.value, arrival, facts, clientGone);
}

async function handleClick(
  parts: DaemonParts,
  verb: string,
  value: string,
  arrival: ClickArrival,
  facts: RequestFacts,
  clientGone: () => boolean,
): Promise<RequestOutcome> {
  if (verb === VERB_RANGE) {
    // [LAW:no-silent-failure] A link the bar draws never names this verb; one
    // that did would be a click that only ever clicks another.
    if (arrival.via === "tmux-status") {
      return {
        kind: "bad-request",
        problems: ["a status-line link names another status-line click"],
      };
    }
    noteFacts(facts, { verb });
    return statusLineClick(parts, value, facts, clientGone);
  }
  // [LAW:single-enforcer] The click's one read: its event carries it, and its
  // run, its journal and its landing all take the click's session from it.
  const click = readClick(verb, value);
  if (click === null) {
    return { kind: "bad-request", problems: [`unknown click verb: ${verb}`] };
  }
  noteFacts(facts, { [VERB_FACT[arrival.via]]: verb });
  // The click's session, as it crossed the one session-id checkpoint: one
  // that passed is recorded, and a click naming none, or one that failed, records
  // `sid=-`, so what a link spelled never reaches the log unchecked.
  noteFacts(facts, { sid: clickSession(click) ?? "-" });
  const { answer } = await apply(
    { kind: "click", click, arrival, gone: clientGone },
    parts,
  );
  // A refused click is answered as data, so the effects its landed steps
  // described still run; the wire reads the refusal as it always has, by its
  // class (`clickRan`).
  if (answer !== null) throw answer.error;
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
  if (isBarLink(click.url)) {
    // A link a config wrote with a malformed escape is refused, as any
    // click's malformed wire encoding is, on the one link path.
    return linkClick(
      parts,
      click.url,
      { via: "tmux-status" },
      facts,
      clientGone,
    );
  }
  await clickHandoff(
    parts.launcher,
    {
      bin: process.platform === "darwin" ? "/usr/bin/open" : "xdg-open",
      args: [click.url],
      category: "click.open",
    },
    `opening ${click.url}`,
    parts.log,
    CLICK_PROGRAM_TIMEOUT_MS,
    parts.tmp,
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
