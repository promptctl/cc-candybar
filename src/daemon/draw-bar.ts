// One render of a session, a request's or a frame's, and what it records.

import path from "node:path";
import { checkoutLocation } from "../utils/git-root.js";
import { inTmux } from "../tmux-hint.js";
import { inspect } from "node:util";
import {
  fileEventsWarnings,
  type FileEventsWarning,
} from "./cache/file-events";
import type { LifelineWarning } from "../proc/launch";
import type { CheckedRenderRequest } from "./render-checkpoint.js";
import { UPDATE_DISMISSED_KEY } from "./update-notice";
import { type RenderOrigin } from "../config-hint";
import {
  PROTOCOL_VERSION,
  refusedHints,
  refusedArgsError,
  refusedHintsError,
  type RenderEncoding,
  type Response,
} from "./protocol";
import { type SessionId } from "./session-id";
import { repoQuestions } from "./repo-configs";
import {
  type CacheEntry,
  type DslRenderState,
  type SessionHold,
  type SessionView,
} from "./cache/render";
import { watchFault } from "./cache/watchers";
import {
  SESSION_RENDER_ORIGIN_KEY,
  SESSION_CLIENT_HINTS_KEY,
  encodeRenderOrigin,
  sessionRenderOrigin,
} from "./verbs";
import { roleOf, answeredOf } from "./render-sightings";
import { drawDsl, type RenderWarning } from "../dsl/render.js";
import type { DrawnMotion } from "../render/drawn-motion.js";
import {
  composeBar,
  renderFailedFrame,
  standIn,
  type Frame,
} from "../render/frame.js";
import {
  renderOptionsOf,
  renderWidth,
  gitOptionsFromClosure,
  prFactOf,
  sourcesFactOf,
  settlePayload,
  refreshedFact,
  type Refreshed,
  todayOf,
  type PayloadInputs,
} from "./render-payload.js";
import { type SessionSource } from "./session-source.js";
import { isPending } from "../utils/outcome.js";
import {
  laneSwitches,
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "../config/effective-globals.js";
import { type PassageFrame } from "../render/effect.js";
import { feedsFact, type FeedFrame, type Refusal } from "./frame-feed.js";
import {
  LANE_NAMES,
  LANES,
  ANSWERING,
  type Drawing,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import { clickErrorAt, type ClickErrorRecord } from "./click-error.js";
import { type LaneSession } from "./lane-setup.js";
import { handedOffTo, laneHandoff } from "./lane-handoff.js";
import {
  collectDiagnostics,
  copyKeys,
  type SourcedText,
  diagnosticsProjection,
  handoffRows,
  type DiagnosticList,
  viewedIndex,
  viewerRowCap,
  viewerRows,
  type DiagnosticGeometry,
} from "../render/diagnostics.js";
import { DIAGNOSTICS_VIEWING } from "../config/door.js";
import { type Instant } from "../utils/instant.js";
import { waitWithin } from "../utils/reading.js";
import { noteFacts, requestEvent, type RequestFacts } from "./request-event.js";

import type { DaemonParts } from "./daemon-parts.js";

// What a reply's sender records once the client holds a response carrying
// nothing to record.
export const NOTHING_DELIVERED = (): void => {};

// [LAW:single-enforcer] The one reply to a request whose handler threw — a
// render's own throw, or any other handler's that reached the connection.
export const renderFailed = (err: unknown): Refusal => ({
  ok: false,
  error: err instanceof Error ? err.message : inspect(err),
  code: "RENDER_FAILED",
  daemonV: PROTOCOL_VERSION,
});

// [LAW:dataflow-not-control-flow] A render's answer in each encoding, looked up
// by the value the checkpoint parsed. Keyed by the type, so a new encoding names
// its answer here or fails to compile.
const RENDER_ANSWERS: Readonly<
  Record<RenderEncoding, (frame: Frame) => Response>
> = {
  ansi: (frame) => ({ ok: true, output: composeBar(frame) }),
  frame: (frame) => ({ ok: true, frame }),
};

// One frame of a subscribed session, drawn from its latest request at this
// instant, by the render a request gets. The response is what that request
// would draw, in the bytes its lanes read whatever encoding it asked its own
// answer in, and the bar moves when its effects say it does.
// [LAW:parse-dont-validate] The request the session's view is declared with
// crossed the checkpoint when it arrived, so a frame draws by it without
// asking again. Null while the session has no view: a frame opens none.
// [LAW:nothing-unseen] A frame that throws carries the render event a throwing
// request writes, for the feed to log when that failure is first pushed; the
// feed summarizes the frames that render.
// [LAW:effects-at-boundaries] Synchronous by type: a frame reads every value
// as its owner stored it (the view's payload), so it performs no I/O and
// refreshes no source — the request it is drawn from made those refreshes,
// and an event, never a frame, opened the view it draws.
export function renderFrame(
  parts: DaemonParts,
  sessionId: string,
  fps: number,
  at: Instant,
): FeedFrame | null {
  const { clock, frameFeeds } = parts;
  const started = clock.date().getTime();
  const facts: RequestFacts = [];
  try {
    using setup = setUpFrame(parts, sessionId, at, facts);
    if (setup === null) return null;
    const { drawn, evaluated, delivered, lanes } = drawRender(parts, setup, {
      by: "feed",
      fps,
    });
    const answer = RENDER_ANSWERS.ansi(drawn.body);
    const statusline = statuslineOf(
      sessionId,
      drawn,
      handedOffTo(lanes, frameFeeds.following(sessionId)),
    );
    return {
      bar: drawn.body,
      resp: answer,
      // Mostly the bar itself, and one frame encodes once.
      statusline:
        statusline === drawn.body ? answer : RENDER_ANSWERS.ansi(statusline),
      evaluated,
      delivered,
      failure: null,
    };
  } catch (error) {
    const outcome = { kind: "threw", error } as const;
    const { level, line } = requestEvent(
      "render",
      facts,
      outcome,
      clock.date().getTime() - started,
    );
    const failed = renderFailed(error);
    return {
      bar: renderFailedFrame(failed.error),
      resp: failed,
      statusline: failed,
      evaluated: 0,
      delivered: NOTHING_DELIVERED,
      failure: { level, line: `frame ${line}` },
    };
  }
}

// [LAW:one-source-of-truth] A session's globals over the render state it
// draws with: the one resolution a render draws by and the lane gate reads.
// `.preset.customized` reads THIS state's authoredRoots — the set computed
// from the SAME raw parse that produced state.config, on the same reload —
// never a fresh file read that could race a concurrent write and disagree with
// the tree that actually rendered.
function sessionGlobals(
  parts: DaemonParts,
  sessionId: string,
  state: DslRenderState,
): EffectiveGlobals {
  const { sessionState } = parts;
  return resolveEffectiveGlobals(
    state.config,
    (key) => sessionState.get(sessionId, key),
    (preset) => state.authoredRoots.has(preset),
  );
}

// The lanes the session's settings switch on now, as its view draws them, or
// null while it has no view: a pure read of the view a frame finds, which
// opens nothing (`holdView`).
export function viewLanes(
  parts: DaemonParts,
  sessionId: string,
): LaneSwitches | null {
  const { renderCache } = parts;
  using hold = renderCache.holdView(sessionId);
  return hold === null
    ? null
    : laneSwitches(
        hold.view.source.effective(),
        inTmux(hold.view.facts().hints.tmux),
      );
}

// The lanes `sessionId`'s settings switch on over the config `origin`
// resolves to, as the render cache holds it, in the pane its latest request
// reported — the same request a click's setups and status line follow
// (laneClicked). A session this daemon has no request from has no pane fact
// yet, so its switches are its settings alone: what the click moves is owed
// to its first request, which settles it against the pane that request
// reports (`arrived`), so a session outside tmux is owed nothing it can run.
export function lanesAt(
  parts: DaemonParts,
  origin: RenderOrigin,
  sessionId: string,
): LaneSwitches {
  const { renderCache, frameFeeds } = parts;
  using hold = renderCache.hold(
    origin.projectDir,
    origin.cwd,
    origin.target.path,
  );
  const latest = frameFeeds.latest(sessionId);
  // [LAW:dataflow-not-control-flow] exception: a click with no request on
  // record (none since a restart, or its last one evicted) has no hint, and is measured as if in
  // tmux so a tmux session's click owes its setup; the owed setup is settled
  // against the session's own hint when its next event arrives.
  return laneSwitches(
    sessionGlobals(parts, sessionId, hold.state),
    latest === null || inTmux(latest.hints.tmux),
  );
}

// What a render of a checked request draws with, resolved once and held for
// the render: the state and the session's view of it, the globals it resolves
// under the session's picks, and what its payload reads. Disposing it releases
// the hold. `facts` is the render event's record, filled as each stage learns
// its part.
interface RenderSetup extends Disposable {
  readonly req: CheckedRenderRequest;
  readonly at: Instant;
  readonly facts: RequestFacts;
  readonly sessionId: SessionId;
  readonly entry: CacheEntry;
  readonly state: DslRenderState;
  readonly view: SessionView<SessionSource>;
  readonly hintsError: string | null;
  // What the request's refresh and wait read (settlePayload).
  readonly payloadInputs: PayloadInputs;
}

// What a render notes of the request it draws by, and the error message for
// the hints that request refused.
function requestFacts(
  req: CheckedRenderRequest,
  at: Instant,
  facts: RequestFacts,
): string | null {
  noteFacts(facts, {
    sid: req.sessionId,
    at: at.toFixed(3),
  });
  // [LAW:parse-dont-validate] The ONE checkpoint for everything the client
  // observed and the daemon cannot. Raw `req.*` hint fields are not read
  // past this line; `hints` is the stamped type the render path consumes.
  //
  // [LAW:single-enforcer] Every hint is captured client-side because the
  // daemon is detached and shared: its env answers for whichever shell
  // spawned it. We do NOT consult getTerminalWidth's env/stderr fallbacks
  // for width, and we do NOT consult SSH_* for remoteness — both would
  // describe a different session than the one being rendered.
  const hints = req.hints;
  const refused = refusedHints(req, hints);
  const hintsError = refusedHintsError(refused);
  noteFacts(facts, {
    termCols: String(hints.termCols ?? "?"),
    termRows: String(hints.termRows ?? "?"),
    refused: refused.map((r) => r.hint).join(",") || "-",
    badArgs: req.refusedArgs.map((r) => `${r.arg}:${r.why}`).join(",") || "-",
    // Which program drew this bar (src/client-hint.ts); `unreported` for a
    // client too old to say.
    client: hints.client?.kind ?? "unreported",
    // What the sighting recorded of the rate-limit windows — the fact the
    // doctor's segment-data check reads (RenderSightings).
    rateLimits: req.rateLimits,
  });
  return hintsError;
}

export function setUpRender(
  parts: DaemonParts,
  arrived: CheckedRenderRequest,
  at: Instant,
  facts: RequestFacts,
): RenderSetup {
  const { sessionState, renderCache } = parts;
  // [LAW:effects-at-boundaries] Read here, on arrival, because a payload does
  // no I/O and a frame draws what the request stored.
  const dir = arrived.hookData.workspace?.current_dir ?? arrived.cwd;
  const req: CheckedRenderRequest = {
    ...arrived,
    hookData: {
      ...arrived.hookData,
      ...(dir !== undefined &&
        path.isAbsolute(dir) && { location: checkoutLocation(dir) }),
    },
  };
  const sessionId = req.sessionId;
  const hintsError = requestFacts(req, at, facts);
  noteFacts(facts, { encoding: req.encoding });
  // [LAW:one-source-of-truth] The explicit config path has three
  // spellings and ONE precedence: a load-config pick (sessionRenderOrigin)
  // over the `--config` flag over the client's `CC_CANDYBAR_CONFIG` hint
  // (checkRenderRequest). All three are client facts; the daemon's own env is
  // never consulted (brandon-config-5g8).
  const origin = sessionRenderOrigin(req.requested, sessionState, sessionId);
  // [LAW:no-ambient-temporal-coupling] Held, not fetched: `state`, and the
  // session's `view` of it, are what this render resolves its payload from and
  // draws with after the payload await below. An eviction, a reload, or the
  // session's own render from another entry meanwhile retires them, and the
  // cache disposes them when this hold is released — never under the render
  // (brandon-unfiled-3248.6rc). The setup owns the hold from here: a throw
  // before it is returned releases it, and the setup releases it on every exit
  // of the render that disposes it.
  const hold = renderCache.holdSession(
    origin.projectDir,
    origin.cwd,
    origin.target.path,
    req,
  );
  return setUpDraw(parts, hold, req, hintsError, at, facts);
}

// [LAW:effects-at-boundaries] A frame's setup: the session's view as it finds
// it, drawn by the request the view is declared with, or null while the
// session has no view. It opens nothing (`holdView`).
function setUpFrame(
  parts: DaemonParts,
  sessionId: string,
  at: Instant,
  facts: RequestFacts,
): RenderSetup | null {
  const { renderCache } = parts;
  const hold = renderCache.holdView(sessionId);
  if (hold === null) {
    // [LAW:no-silent-failure] A view that failed to open draws its error, as
    // the render that threw it did, never the last bar the feed pushed.
    const failed = renderCache.openFailure(sessionId);
    if (failed !== null) throw failed.error;
    return null;
  }
  const req = hold.view.facts();
  let hintsError: string | null;
  try {
    hintsError = requestFacts(req, at, facts);
  } catch (e) {
    hold[Symbol.dispose]();
    throw e;
  }
  return setUpDraw(parts, hold, req, hintsError, at, facts);
}

// The setup over a held view, which owns the hold from here: a throw before
// it is returned releases it.
function setUpDraw(
  parts: DaemonParts,
  hold: SessionHold<SessionSource, CheckedRenderRequest>,
  req: CheckedRenderRequest,
  hintsError: string | null,
  at: Instant,
  facts: RequestFacts,
): RenderSetup {
  const { payloadProviders } = parts;
  try {
    const { entry, state, view } = hold;
    const { sessionId, hints } = req;
    // [LAW:dataflow-not-control-flow] One composition every render: the
    // entry always holds a renderable state (the bundled default until a
    // config loads — src/daemon/cache/render.ts), so body = drawDsl(state)
    // and output = diagnostics + body, with no "did the config load" branch.
    // The picks as the request arrived: what its refresh reads. The draw
    // settles its own (drawRender).
    const effective: EffectiveGlobals = view.source.effective();
    const payloadInputs: PayloadInputs = {
      hookData: req.hookData,
      deps: {
        ...payloadProviders,
        // The lanes the session's view declared: what this render reads of
        // the daemon's shared entries.
        lanes: view.lanes,
      },
      cwd: req.cwd,
      neededInputPaths: state.neededInputPaths(effective.preset),
      hints,
    };
    return {
      req,
      at,
      facts,
      sessionId,
      entry,
      state,
      view,
      hintsError,
      payloadInputs,
      [Symbol.dispose]: () => hold[Symbol.dispose](),
    };
  } catch (e) {
    hold[Symbol.dispose]();
    throw e;
  }
}

// [LAW:one-source-of-truth] The one draw of a render, a request's or a
// frame's: synchronous, so between its payload's values and its bytes nothing
// is awaited and nothing refreshed. Returns the bar at the setup's instant. A
// throw is the caller's to record.
export function drawRender(
  parts: DaemonParts,
  setup: RenderSetup,
  drawing: Drawing,
): {
  drawn: DrawnBar;
  evaluated: number;
  clickShown: ClickErrorRecord | null;
  // Records what the frame's copy clicks copy, once it reached its client.
  delivered: () => void;
  // Which animation lanes the session's settings switch on, as drawn.
  lanes: LaneSwitches;
} {
  const {
    sessionState,
    frameFeeds,
    renderCache,
    updateWatch,
    linkSigner,
    fileEvents,
    renderWarnings,
    payloadProviders,
    effectSessions,
    menuIdle,
    launcher,
  } = parts;
  const { req, at, facts, sessionId, entry, state, view, hintsError } = setup;
  // [LAW:no-ambient-temporal-coupling] The picks this draw settles in its own
  // turn, the one its slots and payload are read in: a pick that moved during
  // a request's wait is drawn as one snapshot of the new one.
  // [LAW:one-source-of-truth] Every globals field as the session's view
  // resolved it (src/daemon/session-source.ts) — the same struct its
  // payload's `*.effective` fields (what a trigger label says) are read
  // from, and renderOpts below (what actually renders). One resolution, two
  // readers, so a label can never disagree with the bar. The precedence
  // the resolver applies, and why each rung sits where it does, lives
  // with the chain (resolveEffectiveGlobals, and src/config/presets.ts).
  const effective = view.source.effective();
  // Which animation lanes this session's settings switch on, as drawn.
  const lanes = laneSwitches(effective, inTmux(view.facts().hints.tmux));
  noteFacts(facts, {
    lanes: LANE_NAMES.filter((lane) => lanes[lane]).join(",") || "-",
  });
  // [LAW:one-source-of-truth] The width is `renderWidth` of the hints the
  // view draws by — the client's cols, else the default, less Claude Code's
  // reserve — the same request its payload carries as `term.cols`.
  const { hints } = view.facts();
  const width = renderWidth(hints);
  noteFacts(facts, { width: String(width) });
  // [LAW:one-source-of-truth] What the view keeps, and the facts of this
  // draw's own instant (DRAW_PROJECTIONS): who it is for, the frames each
  // lane was sent in the second up to it, and the day `today` sums.
  const payload = view.source.payload();
  // [LAW:no-ambient-temporal-coupling] The click error dispatch held for this
  // session, at this draw's instant and for whom it draws: shown by every
  // render inside its hold, and past it by a request until an answer has
  // carried it.
  const clickHold = clickErrorAt(sessionState, sessionId, at, drawing.by);
  const clickShown =
    clickHold.kind === "held" || clickHold.kind === "owed"
      ? clickHold.error
      : null;
  // [LAW:one-source-of-truth] The daemon-wide update notice, read for
  // THIS session: what it dismissed and whether its config allows the
  // notice — both values, folded by the notice into zero or one message.
  const updates = updateWatch.notice({
    sessionId,
    dismissed: sessionState.get(sessionId, UPDATE_DISMISSED_KEY),
    enabled: effective.updateNotice,
  });
  // [LAW:single-enforcer] Each repository awaiting the user's answer asks,
  // in every session drawn from the entry, until one of them answers.
  const questions = repoQuestions(entry.repos, sessionId, linkSigner);
  // What a load or a request could not honour: each its own message, named by
  // what it is about. A load's error is about the session's config, and a
  // drop about the file that wrote it, so their text may change under an open
  // viewer (an issue fixed) without becoming another message; a request's
  // refusal, its hints' and a click's are about exactly what their text says.
  // Each copies its own text, but a drop copies the prompt that fixes it.
  const sourced = (about: string, text: string | null | undefined) => ({
    about,
    text,
    copy: text,
  });
  const said = (text: string | null | undefined) => sourced(text ?? "", text);
  const errors: SourcedText[] = [
    said(refusedArgsError(req.refusedArgs)),
    said(hintsError),
    sourced("load", entry.lastError),
    sourced("update-act", updateWatch.error()),
    ...state.dropped.map((e) => ({
      about: `dropped\0${e.file}`,
      text: e.message,
      copy: e.prompt,
    })),
    said(clickShown?.text),
  ].flatMap(({ about, text, copy }) =>
    about && text && copy ? [{ about, text, copy }] : [],
  );
  // What stands before the draw: whether the daemon can vouch that a config
  // edit reloads and that what it launches dies with it, what this config's
  // watch cannot hear, and the warning this config's load carried.
  // [LAW:no-silent-failure] A config whose link chain the watch cannot walk,
  // or whose folder the OS will not watch, may miss an edit: the bar says so.
  // A stall is no reason of this watch's: it has the bar's own row.
  const configWatch =
    entry.watch === null ? null : watchFault("config watch", entry.watch, null);
  const standing: readonly StandingWarning[] = [
    ...fileEventsWarnings(fileEvents.delivery()),
    ...launcher.lifelineWarnings(),
    ...(configWatch === null
      ? []
      : [{ kind: "config-watch" as const, message: configWatch }]),
    ...(entry.lastWarning === null
      ? []
      : [{ kind: "load" as const, message: entry.lastWarning }]),
  ];
  // [LAW:one-source-of-truth] ONE list per draw, built before it: the door's
  // indicator reads it as the `diagnostics` projection and the viewer pages
  // the same object, so the two cannot disagree within a frame. The render
  // warnings are this renderer's recorded ones — known only after a walk, so
  // the frame before this one's — with every other renderer's for the
  // session (src/daemon/render-warnings.ts).
  const scope = { config: state.config };
  const diagnostics = collectDiagnostics(
    sessionId,
    drawing.by,
    errors,
    [...updates, ...questions],
    [
      ...standing,
      ...renderWarnings.ofSession(sessionId, drawing.by, scope),
    ].map((w) => ({
      about: `${w.kind}\0${w.message}`,
      text: w.message,
      copy: w.message,
    })),
  );
  const projected = {
    diagnostics: diagnosticsProjection(diagnostics),
    drawing,
    feeds: frameFeeds.feedsOf(sessionId, at),
    today: todayOf(
      payloadProviders,
      view.lanes().today,
      view.facts().hookData,
      at,
    ),
  };
  const metrics = isPending(payload.metrics) ? undefined : payload.metrics;
  noteFacts(facts, sourcesFactOf(view.lanes().sources));
  noteFacts(facts, {
    prompts: String(metrics?.messageCount ?? "-"),
    nonPrompts: String(metrics?.nonPrompts ?? "-"),
    pr: prFactOf(
      payload.git,
      gitOptionsFromClosure(setup.payloadInputs.neededInputPaths)
        .showPullRequest === true,
    ),
    feeds: feedsFact(projected.feeds),
  });
  // [LAW:no-silent-failure] What renderDsl had to settle for itself and could
  // not honour (`RenderWarning`): this frame's own, recorded for its renderer
  // after the walk, so the bar still renders and the indicator counts them.
  const drawnWarnings: RenderWarning[] = [];
  // [LAW:one-source-of-truth] The options renderDsl draws with are the SAME
  // `effective` struct the payload was just built from, projected by the one
  // `renderOptionsOf` every renderer shares — no second `?? DEFAULT_X`
  // computation to drift from it.
  const renderOpts = renderOptionsOf(effective, width);
  const effects = effectSessions.of(sessionId);
  const idleSince = menuIdle.since(sessionId, at);
  // [LAW:single-enforcer] The view's inputs read its source (`bindView`, at
  // its opening): the draw hands only its own instant's facts.
  const { frame, evaluated, rules } = drawDsl(
    state.config,
    state.compiled,
    view.store,
    view.registry,
    projected,
    at,
    renderOpts,
    // [LAW:single-enforcer] The per-segment StripCell sink for the
    // `debug segments` projection. Its identity stays stable for the
    // view's lifetime; drawDsl clears + repopulates it
    // in place. Cells are cheap (already computed during the render);
    // the per-segment ANSI serialization happens lazily inside the
    // debug handler so normal renders pay no extra serializer cost.
    {
      perSegmentSink: view.lastRenderCellsBySegment,
      onRenderWarning: (warning) => drawnWarnings.push(warning),
    },
    // [LAW:one-source-of-truth] The draw's own settings and the session's
    // effect memory. The theme, style and effect are not among them: the
    // view's slots settle those names (src/dsl/parts.ts), the same ones its
    // payload's `.effective` fields read.
    { ...effective, effects, idleSince },
  );
  // [LAW:one-source-of-truth] What each copy click this frame mints copies,
  // read back when the click runs (the copy-diagnostic verb): the list this
  // renderer last delivered, never text carried in the link. Recorded when
  // the frame reaches its client, so a draw that throws, or an answer that
  // never arrives, leaves the shown frame's copies.
  const keys = copyKeys(diagnostics);
  const copies = new Map(diagnostics.map((m, i) => [keys[i]!, m.copy]));
  const delivered = (): void =>
    renderCache.delivered(sessionId, drawing.by, copies);
  // What this frame drew is what the session's close timer follows.
  menuIdle.observe(
    sessionId,
    at,
    frame.rows.some((row) => row.kind === "menu"),
    effective.menuTimeout,
  );
  const menusSince = menuIdle.since(sessionId, at);
  noteFacts(facts, {
    menuIdle:
      menusSince === undefined
        ? "-"
        : `${(at - menusSince).toFixed(1)}s/${effective.menuTimeout}s`,
  });
  // [LAW:no-silent-failure] Every frame records what it warned; a record that
  // moved is shown by the renderer's next frame: a feed's next spaced frame,
  // a request's next poll. Nothing wakes for it, since a frame whose own
  // indicator moves what it warns would wake itself forever.
  const recorded = renderWarnings.drawn(
    sessionId,
    drawing.by,
    scope,
    drawnWarnings,
  );
  const geometry: DiagnosticGeometry = {
    width,
    // A feed's one frame is shown by every lane switched on, so it pages
    // within the shortest of their surfaces.
    rows: viewerRowCap(
      hints.termRows,
      drawing.by === "feed"
        ? LANE_NAMES.flatMap((lane) => {
            const rows = LANES[lane].rows;
            return lanes[lane] && rows !== null ? [rows] : [];
          })
        : [],
    ),
    // [LAW:one-source-of-truth] What stands in the frame's place is drawn at
    // the depth the frame is encoded at.
    colorCompatibility: frame.depth,
  };
  // [LAW:dataflow-not-control-flow] The viewer, while open, takes the body's
  // place: open only while the message it was opened on is in this list.
  const viewing = viewedIndex(
    sessionState.get(sessionId, DIAGNOSTICS_VIEWING),
    diagnostics,
  );
  const body: Frame =
    viewing === null
      ? frame
      : standIn(
          frame,
          viewerRows(diagnostics, viewing, sessionId, drawing.by, geometry),
        );
  const g = payloadProviders.gitProvider.getStats();
  const u = payloadProviders.usageStore.getStats();
  const fx = effects.lastFrame();
  // Each placement wearing its own effect, on its own clock; `-` for none.
  const own =
    fx.own
      .map((o) => `${o.placement}:${o.effect}@${o.t.toFixed(3)}`)
      .join(",") || "-";
  // Each placement fading in, and each dissolving out, on its own clock;
  // `-` for none.
  const passages = (frames: readonly PassageFrame[]): string =>
    frames.map((f) => `${f.placement}@${f.t.toFixed(3)}`).join(",") || "-";
  // [LAW:nothing-unseen] Each warning this frame met, those standing before
  // it and its own walk's, in order; `-` for none. A rule's tag names
  // the slot that fell to its floor (`rule:style`), and a refresh's the
  // variable that stopped (`refresh:stamp`), so the event says which.
  // [LAW:types-are-the-program] Exhaustive over the kinds: a new kind is a
  // compile error here until the event says how to name it.
  const tagOf = (w: StandingWarning | RenderWarning): string => {
    switch (w.kind) {
      case "rule":
        return `rule:${w.slot}`;
      case "refresh":
        return `refresh:${w.variable}`;
      case "file-events":
        return `${w.kind}:${w.state}`;
      case "load":
      case "config-watch":
      case "lifeline":
      case "when":
        return w.kind;
    }
  };
  const warned = [...standing, ...drawnWarnings].map(tagOf).join(",") || "-";
  noteFacts(facts, {
    git: `${g.size}/${g.hits}h/${g.misses}m`,
    usage: `${u.size}/${u.hits}h/${u.misses}m`,
    effect: fx.effect,
    effectT: fx.t.toFixed(3),
    // The rate the session's animation clock ran at for this frame.
    speed: `${fx.speed}x`,
    effectRows: `${fx.made}made/${fx.reused}reused`,
    effectOwn: own,
    fadeBasis: fx.basis,
    stateRev: String(fx.revision),
    fades: passages(fx.fades),
    leaves: passages(fx.leaves),
    // What the body drew: whether anything on it changes without new data.
    motion: body.motion,
    // How many of the view's parts it evaluated: between data changes, only
    // those that read the instant (src/dsl/parts.ts).
    evaluated: String(evaluated),
    // The sources it drew as not answered yet; `-` for none.
    pending: body.pending.join(",") || "-",
    // Each globals rule in force, as its slot settled it: `kept` outside the
    // draw, `per-draw` at this frame's instant; `-` for none.
    rules: [...rules].map(([slot, how]) => `${slot}:${how}`).join(",") || "-",
    err: errors.length > 0 ? "Y" : "N",
    clickError: clickHold.kind === "none" ? "-" : clickHold.kind,
    upd: String(updates.length),
    // How many repositories the bar asked about.
    ask: String(questions.length),
    warn: warned,
    // What the indicator counted, and whether this frame's warnings moved
    // its renderer's record (`new`) or matched it (`kept`).
    diag: String(diagnostics.length),
    warnRecord: recorded ? "new" : "kept",
    // The message the viewer showed in the body's place, `-` while closed.
    viewer:
      viewing === null
        ? "-"
        : `${viewing.index}/${diagnostics.length}p${viewing.page + 1}`,
  });
  return {
    drawn: {
      body,
      viewerOpen: viewing !== null,
      diagnostics,
      geometry,
    },
    evaluated,
    clickShown,
    delivered,
    lanes,
  };
}

// The warning a load carried, beside what a draw could not honour.
interface LoadWarning {
  readonly kind: "load";
  readonly message: string;
}

// What the config's watch cannot hear, so an edit may not reload.
interface ConfigWatchWarning {
  readonly kind: "config-watch";
  readonly message: string;
}

// What stands before a draw, whatever the draw then meets.
type StandingWarning =
  | FileEventsWarning
  | LifelineWarning
  | ConfigWatchWarning
  | LoadWarning;

// What one render drew: the body — the bar, or the viewer in its place — and
// what the statusline's handoff line is drawn from: whether the body is the
// viewer, the draw's one diagnostic list, and the geometry.
interface DrawnBar {
  readonly body: Frame;
  readonly viewerOpen: boolean;
  readonly diagnostics: DiagnosticList;
  readonly geometry: DiagnosticGeometry;
}

// [LAW:effects-at-boundaries] What a render request said, recorded where the
// request arrives — never by a frame, which only draws, and which would wake
// its own feed by writing the session's state. Compared before writing:
// every set() persists and fires the session's MobX atom, so an
// unconditional per-request write would invalidate every state-driven
// computed each render.
function recordRequest(parts: DaemonParts, req: CheckedRenderRequest): void {
  const { sessionState } = parts;
  const sessionId = req.sessionId;
  // [LAW:one-source-of-truth] The STAMPED hints: a click arrives with no
  // hints of its own, so the doctor (verbs/index.ts) reads the facts of this
  // session's last request from here, re-parsed through the same checkpoint.
  // The client itself is not recorded: which client drew a session's bar is
  // RenderSightings' fact (src/daemon/render-sightings.ts), held in memory,
  // and two clients drawing one session would otherwise rewrite this
  // persisted record on every request.
  const { client: _client, ...recorded } = req.hints;
  const hintRecord = JSON.stringify(recorded);
  if (sessionState.get(sessionId, SESSION_CLIENT_HINTS_KEY) !== hintRecord) {
    sessionState.set(sessionId, SESSION_CLIENT_HINTS_KEY, hintRecord);
  }
  // [LAW:one-source-of-truth] The config inputs this request named, so a
  // durable click on this session resolves the same chain (under the
  // session's load-config pick, verbs/index.ts sessionOrigin) and writes the
  // file the next reload reads — never a path re-derived from the daemon's
  // own cwd.
  const origin = encodeRenderOrigin(req.requested);
  if (sessionState.get(sessionId, SESSION_RENDER_ORIGIN_KEY) !== origin) {
    sessionState.set(sessionId, SESSION_RENDER_ORIGIN_KEY, origin);
  }
}

// A render request's answer: what it said is recorded, and the bar is drawn.
interface RequestAnswer {
  // What this request's client is answered with: the statusline's answer to
  // Claude Code's statusline, the bar to a client drawing it itself.
  resp: Response;
  motion: DrawnMotion;
  clickShown: ClickErrorRecord | null;
  // Records what the answer's copy clicks copy, once it reached its client.
  delivered: () => void;
}

export async function answerRequest(
  parts: DaemonParts,
  req: CheckedRenderRequest,
  at: Instant,
  waitEndsAt: number,
  facts: RequestFacts,
): Promise<RequestAnswer> {
  recordRequest(parts, req);
  return drawAnswer(parts, req, at, waitEndsAt, facts);
}

// [LAW:effects-at-boundaries] What a request's arrival starts beyond its
// own answer, in its arrival turn, by the lanes its session's settings switch
// on as it arrived: the setups its session's clicks owe
// (src/daemon/lane-setup.ts), and the tmux status line its switch and pane
// hold (src/daemon/tmux-status.ts) — held again here after `answered`
// released it, and by nothing between requests, so a status line another
// session's save turned off is never re-taken from a remembered switch. No
// draw starts either.
function arrived(
  parts: DaemonParts,
  req: CheckedRenderRequest,
  lanes: LaneSwitches,
): void {
  const { laneSetups, tmuxStatusLines } = parts;
  laneSetups.noted(laneSessionOf(parts, req), lanes);
  tmuxStatusLines.observe(
    req.hookData.session_id,
    req.hints.tmux,
    lanes.tmuxStatus,
  );
}

// [LAW:one-source-of-truth] A session as a lane's setup needs it: what its
// request `req` reported, and the config inputs it renders from now.
export function laneSessionOf(
  parts: DaemonParts,
  req: CheckedRenderRequest,
): LaneSession {
  const { sessionState } = parts;
  const sessionId = req.hookData.session_id;
  return {
    sessionId,
    hints: req.hints,
    origin: sessionRenderOrigin(req.requested, sessionState, sessionId),
    transcript: req.hookData.transcript_path,
    answered: answeredOf(req.hookData),
  };
}

// What follows a click of `sessionId` that found its lane switches at
// `before` and left them at `after`: each lane it moved is set up for the
// session as its latest request reported it, or owed to its first request;
// and a tmux status line switch it moved is followed in the pane that request
// reported. A click that left that switch alone holds nothing: the pane is
// only remembered, and `answered` may have released it to the session that
// took it since.
export function laneClicked(
  parts: DaemonParts,
  sessionId: string,
  before: LaneSwitches,
  after: LaneSwitches,
): void {
  const { frameFeeds, laneSetups, tmuxStatusLines } = parts;
  const latest = frameFeeds.latest(sessionId);
  laneSetups.clicked(
    sessionId,
    latest === null ? null : laneSessionOf(parts, latest),
    before,
    after,
  );
  if (latest !== null && before.tmuxStatus !== after.tmuxStatus)
    tmuxStatusLines.observe(sessionId, latest.hints.tmux, after.tmuxStatus);
}

async function drawAnswer(
  parts: DaemonParts,
  req: CheckedRenderRequest,
  at: Instant,
  waitEndsAt: number,
  facts: RequestFacts,
): Promise<RequestAnswer> {
  const { clock, frameFeeds, log } = parts;
  using setup = setUpRender(parts, req, at, facts);
  arrived(
    parts,
    req,
    laneSwitches(setup.view.source.effective(), inTmux(req.hints.tmux)),
  );
  // Rules 1 and 2 of the model: the answer shows what this request carried,
  // so it waits for the refreshes its arrival triggers, the first value of
  // every keyed lane its view declared, and every run of its view's or its
  // directory's sources that answers a new key — a first value, or a key its
  // fields moved — until its client's deadline. What has not
  // answered by then draws as pending, and lands for the next frame.
  const waitFrom = clock.monotonic();
  // [LAW:one-source-of-truth] The event's figure and the wait's timer are one
  // reading. Setup has spent part of what the request arrived with, and below
  // zero says by how much it overran: the timer fires at once.
  const budget = waitEndsAt - waitFrom;
  noteFacts(facts, {
    deadline: `${req.deadline.kind}:${Math.round(budget)}ms`,
  });
  const refreshed: Refreshed = new Map();
  const ended = await waitWithin(
    (signal) =>
      Promise.all([
        settlePayload(setup.payloadInputs, at, refreshed),
        setup.view.registry.inFlight(signal),
      ]),
    budget,
    // [LAW:no-silent-failure] The answer is drawn; a wait that fails after
    // it is a bug, said against the session, never one that ends the daemon.
    (e) =>
      log(
        "error",
        `render wait failed after its deadline sid=${JSON.stringify(setup.sessionId)}: ${inspect(e)}`,
      ),
    clock.after,
  );
  // [LAW:nothing-unseen] How the wait went, on the render event: an answer
  // drawn with values pending says so by name.
  const drawFrom = clock.monotonic();
  noteFacts(facts, {
    waited: `${Math.round(drawFrom - waitFrom)}ms`,
    ended,
    refreshed: refreshedFact(refreshed),
  });
  const { drawn, clickShown, delivered, lanes } = drawRender(
    parts,
    setup,
    ANSWERING,
  );
  const sessionId = req.sessionId;
  const elsewhere = handedOffTo(lanes, frameFeeds.following(sessionId));
  // A `frames` display draws the bar itself; Claude Code's statusline hands
  // it to the lanes drawing it elsewhere.
  const toStatusline = roleOf(req.hints.client ?? null) === "statusline";
  const resp = RENDER_ANSWERS[req.encoding](
    toStatusline ? statuslineOf(sessionId, drawn, elsewhere) : drawn.body,
  );
  // [LAW:nothing-unseen] Which lanes the statusline handed the bar to, and
  // how long the turn after the wait took to make the answer — what the
  // draw's reserve is held to (DRAW_RESERVE_MS), so an `ansi` answer's bytes
  // are encoded before this is read.
  noteFacts(facts, {
    handoff: (toStatusline ? elsewhere : []).join(",") || "-",
    drew: `${Math.round(clock.monotonic() - drawFrom)}ms`,
  });
  return {
    resp,
    motion: drawn.body.motion,
    clickShown,
    delivered,
  };
}

// What Claude Code's statusline shows of `drawn`: the bar, or — while lanes
// draw it `elsewhere` — the handoff line, which says where, with the bar's
// indicator after it. [LAW:one-source-of-truth] The indicator reads the draw's
// one list, and its click opens the one viewer: while it is open the statusline
// shows it, the same body the lanes draw.
function statuslineOf(
  sessionId: string,
  drawn: DrawnBar,
  elsewhere: readonly Lane[],
): Frame {
  const [first, ...rest] = elsewhere;
  return first === undefined || drawn.viewerOpen
    ? drawn.body
    : standIn(
        drawn.body,
        handoffRows(
          laneHandoff(sessionId, [first, ...rest]),
          drawn.diagnostics,
          sessionId,
          drawn.geometry,
        ),
      );
}
