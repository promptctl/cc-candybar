// One render of a session, a request's or a frame's, and what it records.

import type { FileEventsWarning } from "../daemon/foundations/file-events-warnings";
import { launcherWarningsAt, type LauncherWarning } from "../proc/launcher";
import {
  DAEMON_EVENT_HOLD_S,
  eventHoldAt,
  type HeldEvent,
} from "../utils/event-hold.js";
import { type CheckedRenderRequest } from "../renderer-interface/request-context.js";
import { type RenderOrigin } from "../config-hint";
import {
  refusedHints,
  refusedArgsError,
  refusedHintsError,
} from "../daemon/foundations/protocol";
import { type SessionId } from "../daemon/foundations/session-id";
import type { LayerRole } from "../config/layer-role";
import { repoQuestions } from "../config/repo-question";
import {
  type CacheEntry,
  type RenderCache,
  type DslRenderState,
  type SessionHold,
  type SessionView,
} from "./render-cache";
import { roleOf } from "../daemon/foundations/sighting-roles";
import { drawDsl, type RenderWarning } from "../dsl/render.js";
import { renderFailedFrame, standIn, type Frame } from "../render/frame.js";
import {
  renderOptionsOf,
  prFactOf,
  sourcesFactOf,
  instantFacts,
} from "./render-payload.js";
import { type SessionSource } from "./session-source.js";
import { runInAction } from "mobx";
import type { RichText } from "@promptctl/rich-js";
import type { WorldState } from "../facts/world-state.js";
import type { WorldStates } from "./world-states.js";
import { isPending } from "../utils/outcome.js";
import { laneSwitches } from "../config/effective-globals.js";
import {
  type PassageFrame,
  type EffectSessions,
  type SessionMotion,
} from "../render/effect.js";
import type { FrameRecord } from "../render/frame-memory.js";
import {
  feedsFact,
  LANE_NAMES,
  ANSWERING,
  type Drawing,
  type Lane,
  type LaneFeeds,
  type LaneSwitches,
} from "../config/lanes.js";
import { type AdapterToHost } from "../renderer-interface/adapter.js";
import type { Fault } from "../renderer-interface/noted-faults.js";
import type { FeedDraw, Feeds } from "./feeds.js";
import type { MenuIdle } from "./menu-idle.js";
import type { TurnTime } from "./turn-time.js";
import {
  answeredClickError,
  clickErrorAt,
  type ClickErrorRecord,
} from "../daemon/foundations/click-error.js";
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
import { type Instant, type Readings, type Tick } from "../utils/instant.js";
import {
  drawEvent,
  noteFacts,
  type RequestFacts,
} from "../daemon/foundations/request-event.js";

import type { SessionState } from "./session-state";
import type { RecordScope, RenderWarningRecords } from "./render-warnings.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import { signingFrames, type LinkSigner } from "../click/link-signer.js";
import { failureOf } from "../daemon/foundations/verb-error.js";
import {
  failedWith,
  renderFailure,
  RENDER_ANSWERS,
} from "../daemon/foundations/render-answers";

// The renderer's parts: its own state, and what it reaches in the host
// (`AdapterToHost`, src/renderer-interface/adapter.ts), each by the methods it
// calls. `worldStates` holds the world states the host handed in, which its
// views read.
export interface RendererState {
  // The turn's time, handed in by the host: no draw reads a clock.
  readonly time: TurnTime;
  readonly sessionState: SessionState;
  readonly renderCache: RenderCache<SessionSource, CheckedRenderRequest>;
  readonly worldStates: WorldStates;
  readonly renderWarnings: RenderWarningRecords;
  readonly effectSessions: EffectSessions<RenderedLine>;
  // [LAW:single-enforcer] The signer every link this renderer draws is
  // signed with, over the state directory's key.
  readonly linkSigner: LinkSigner;
  // Each session's idle period, which a draw reports what it showed to and
  // reads its flash from.
  readonly menuIdle: Pick<MenuIdle, "drew" | "since">;
  // What the feeds know of who watches each session, which a request's
  // answer hands the bar to and shows the rate of.
  readonly feeds: Pick<Feeds, "following" | "feedsOf">;
}

export type RendererParts = RendererState & AdapterToHost;

// One frame of a subscribed session, drawn from its latest request at this
// instant, by the render a request gets. The response is what that request
// would draw, in the bytes its lanes read whatever encoding it asked its own
// answer in, and the bar moves when its effects say it does.
// [LAW:parse-dont-validate] The request the session's view is declared with
// crossed the checkpoint when it arrived, so a frame draws by it without
// asking again. Null while the session has no view: a frame opens none.
// [LAW:nothing-unseen] A frame that throws carries the render event a throwing
// request writes, for the feed to log when that failure first shows; the
// feed summarizes the frames that render.
// [LAW:effects-at-boundaries] Synchronous by type: a frame reads every value
// as its owner stored it (the view's payload), so it performs no I/O and
// refreshes no source — the collector's triggers made those refreshes,
// and an event, never a frame, opened the view it draws.
export function renderFrame(
  parts: RendererParts,
  sessionId: SessionId,
  fps: number,
  // The instant the frame is drawn for, and the tick of the turn drawing it.
  readings: Readings,
  // Which lanes follow the session and draw it now, and what each was sent
  // of late, as the feed knows them.
  following: ReadonlySet<Lane>,
  feeds: LaneFeeds,
): FeedDraw | null {
  const facts: RequestFacts = [];
  try {
    using setup = setUpFrame(parts, sessionId, readings, facts);
    if (setup === null) return null;
    const { drawn, evaluated, cellBreaks, copies, lanes, kept } = drawRender(
      parts,
      setup,
      { by: "feed", fps },
      feeds,
    );
    // [LAW:single-enforcer] Signed as they leave the renderer, the bar and
    // what the statusline shows alike, each link once.
    const signed = signingFrames(parts.linkSigner);
    const bar = signed(drawn.body);
    const answer = RENDER_ANSWERS.ansi(bar);
    const statusline = statuslineOf(
      sessionId,
      setup.state.writable,
      drawn,
      handedOffTo(lanes, following),
    );
    const resp = JSON.stringify(answer);
    // Mostly the bar itself, and one frame encodes once.
    const statuslineResp =
      statusline === drawn.body
        ? resp
        : JSON.stringify(RENDER_ANSWERS.ansi(signed(statusline)));
    // Kept once nothing of the turn is left to throw: a frame that fails
    // part-way leaves the last frame's memory standing.
    keepDraw(parts, setup, kept);
    // [LAW:one-source-of-truth] What the frame's copy clicks copy, recorded
    // as it is handed to the feed: a frame whose bytes match the last shows
    // the same links, and a feed's close retires what the feed drew.
    deliver(parts, {
      session: sessionId,
      by: "feed",
      copies,
      clickShown: null,
      eventsShown: [],
    });
    return {
      bar,
      answers: { resp, statusline: statuslineResp },
      evaluated,
      cellBreaks,
      failure: null,
    };
  } catch (error) {
    const outcome = renderFailure(failureOf(error));
    const { level, line } = drawEvent("render", facts, outcome);
    const answer = failedWith(outcome.message);
    const failed = JSON.stringify(answer);
    return {
      bar: renderFailedFrame(answer.error),
      answers: { resp: failed, statusline: failed },
      evaluated: 0,
      cellBreaks: 0,
      failure: { level, line: `frame ${line}` },
    };
  }
}

// The lanes the session's settings switch on now, as its view draws them, or
// null while it has no view: a pure read of the view a frame finds, which
// opens nothing (`holdView`).
export function viewLanes(
  parts: RendererParts,
  sessionId: SessionId,
): LaneSwitches | null {
  const { renderCache } = parts;
  using hold = renderCache.holdView(sessionId);
  return hold === null ? null : laneSwitches(hold.view.source.effective());
}

// What a render of a checked request draws with, resolved once and held for
// the render: the state and the session's view of it, the globals it resolves
// under the session's picks, and what its payload reads. Disposing it releases
// the hold. `facts` is the render event's record, filled as each stage learns
// its part.
interface RenderSetup extends Disposable {
  readonly req: CheckedRenderRequest;
  // The instant the render is drawn for, and the tick of the turn drawing it.
  readonly readings: Readings;
  readonly facts: RequestFacts;
  readonly sessionId: SessionId;
  readonly entry: CacheEntry;
  readonly state: DslRenderState;
  readonly view: SessionView<SessionSource>;
  readonly hintsError: string | null;
}

// What a render notes of the context it draws by.
function contextFacts(req: CheckedRenderRequest, facts: RequestFacts): void {
  noteFacts(facts, { sid: req.hookData.session_id });
  const { hints } = req;
  noteFacts(facts, {
    termCols: String(hints.termCols ?? "?"),
    termRows: String(hints.termRows ?? "?"),
    refused:
      refusedHints(req, hints)
        .map((r) => r.hint)
        .join(",") || "-",
    badArgs: req.refusedArgs.map((r) => `${r.arg}:${r.why}`).join(",") || "-",
    // Which program drew this bar (src/client-hint.ts); `unreported` for a
    // client too old to say.
    client: hints.client?.kind ?? "unreported",
    // What the sighting recorded of the rate-limit windows — the fact the
    // doctor's segment-data check reads (RenderSightings).
    rateLimits: req.rateLimits,
  });
}

// The error message for the hints the context refused.
//
// [LAW:parse-dont-validate] The ONE checkpoint for everything the client
// observed and the daemon cannot. Raw `req.*` hint fields are not read past
// this line; `hints` is the stamped type the render path consumes.
//
// [LAW:single-enforcer] Every hint is captured client-side because the daemon
// is detached and shared: its env answers for whichever shell spawned it. We
// do NOT read the daemon's env or stderr for width, and we do NOT consult
// SSH_* for remoteness — both would describe a different session than the one
// being rendered.
const hintsErrorOf = (req: CheckedRenderRequest): string | null =>
  refusedHintsError(refusedHints(req, req.hints));

// [LAW:single-enforcer] A `context` turn: the facts of the context it carries
// noted, what the context says recorded, its world state taken, and the
// session's view opened at it and let go, so the turn's output names what the
// view reads before the request after it waits. The record goes first, so a
// durable click on a session whose opening threw still resolves the origin
// that opening was for, and the facts before it, so the request's event says
// what a failed opening was for.
//
// [LAW:one-source-of-truth] The world state and the view's context are taken
// in one action, so nothing drawn between the two pairs either with another
// context's.
export function configureSession(
  parts: RendererParts,
  req: CheckedRenderRequest,
  worldState: WorldState,
  facts: RequestFacts,
): void {
  runInAction(() => {
    takeContext(parts, req, worldState, facts);
    openSession(parts, req);
  });
}

// What a `context` does whether or not its origin's config is held: its
// facts noted, and it and its world state taken, so the
// session's documents are taken in the order the host hands them in, and the
// origin it renders from is the session's.
export function takeContext(
  parts: RendererParts,
  req: CheckedRenderRequest,
  worldState: WorldState,
  facts: RequestFacts,
): void {
  contextFacts(req, facts);
  noteFacts(facts, { encoding: req.encoding });
  runInAction(() => {
    parts.worldStates.take(worldState, facts);
    parts.worldStates.heard(req);
  });
}

// The session's view opened at the context, and let go: what a `context`
// waits for its origin's config to do.
export function openSession(
  parts: RendererParts,
  req: CheckedRenderRequest,
): void {
  holdSessionAt(parts, req)[Symbol.dispose]();
}

// [LAW:single-enforcer] A `retire` turn: the session's world state goes, and
// its view closes. The document goes first, before anything can throw, so the
// turn keeps the retire's contract (src/renderer-interface/interface.ts) however it
// ends; one action holds both, so the view's change reaction, stopped by the
// closing, never runs over the document gone.
export function retireSession(
  parts: Pick<RendererParts, "worldStates"> & {
    readonly renderCache: Pick<RendererParts["renderCache"], "retireSession">;
  },
  session: SessionId,
): void {
  runInAction(() => {
    parts.worldStates.drop(session);
    parts.renderCache.retireSession(session);
  });
}

// [LAW:single-enforcer] The one way a session's view is held at a context:
// opened, or kept and refreshed, at the origin the context names. A
// `context` turn opens it ahead of the request, and the request holds it again
// at its own context, so it draws by the context it carries and needs nothing
// to outlive the turn before it: a view closed between the two opens again.
function holdSessionAt(
  parts: RendererParts,
  req: CheckedRenderRequest,
): SessionHold<SessionSource, CheckedRenderRequest> {
  // [LAW:one-source-of-truth] The explicit config path has two spellings and
  // ONE precedence: the `--config` flag over the client's `CC_CANDYBAR_CONFIG`
  // hint (checkRenderRequest). Both are client facts; the daemon's own env is
  // never consulted (brandon-config-5g8).
  return parts.renderCache.holdSession(req.requested, req);
}

export function setUpRender(
  parts: RendererParts,
  req: CheckedRenderRequest,
  readings: Readings,
  facts: RequestFacts,
): RenderSetup {
  // [LAW:no-ambient-temporal-coupling] Held, not fetched: `state`, and the
  // session's `view` of it, are what this render resolves its payload from and
  // draws with after the payload await below. An eviction, a reload, or the
  // session's own render from another entry meanwhile retires them, and the
  // cache disposes them when this hold is released — never under the render
  // (brandon-unfiled-3248.6rc). The setup owns the hold from here: a throw
  // before it is returned releases it, and the setup releases it on every exit
  // of the render that disposes it. Its facts and its world state came with
  // its `context`.
  const hintsError = hintsErrorOf(req);
  const hold = holdSessionAt(parts, req);
  return setUpDraw(parts, hold, req, hintsError, readings, facts);
}

// [LAW:effects-at-boundaries] A frame's setup: the session's view as it finds
// it, drawn by the request the view is declared with, or null while the
// session has no view. It opens nothing (`holdView`).
function setUpFrame(
  parts: RendererParts,
  sessionId: SessionId,
  readings: Readings,
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
    contextFacts(req, facts);
    hintsError = hintsErrorOf(req);
  } catch (e) {
    hold[Symbol.dispose]();
    throw e;
  }
  return setUpDraw(parts, hold, req, hintsError, readings, facts);
}

// The setup over a held view, which owns the hold from here: a throw before
// it is returned releases it.
function setUpDraw(
  parts: RendererParts,
  hold: SessionHold<SessionSource, CheckedRenderRequest>,
  req: CheckedRenderRequest,
  hintsError: string | null,
  readings: Readings,
  facts: RequestFacts,
): RenderSetup {
  try {
    const { entry, state, view } = hold;
    // The instant the bar is drawn for, which a `context` turn, made before
    // the request waited, cannot say.
    noteFacts(facts, { at: readings.at.toFixed(3) });
    // [LAW:dataflow-not-control-flow] One composition every render: the
    // entry always holds a renderable state (the bundled default until a
    // config loads — src/renderer/render-cache.ts), so body = drawDsl(state)
    // and output = diagnostics + body, with no "did the config load" branch.
    return {
      req,
      readings,
      facts,
      sessionId: req.hookData.session_id,
      entry,
      state,
      view,
      hintsError,
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
  parts: RendererParts,
  setup: RenderSetup,
  drawing: Drawing,
  // What each lane following the session was sent of late, as the bar's rate
  // cell shows it.
  feeds: LaneFeeds,
): {
  drawn: DrawnBar;
  evaluated: number;
  cellBreaks: number;
  clickShown: ClickErrorRecord | null;
  // The held events this draw showed (the launcher's pipe event, the last
  // renderer's end), which an answer carrying them marks answered.
  eventsShown: readonly HeldEvent[];
  // What the frame's copy clicks copy, by key, recorded once the frame
  // reached its client (`deliver`).
  copies: ReadonlyMap<string, string>;
  // Which animation lanes the session's settings switch on, as drawn.
  lanes: LaneSwitches;
  // What the draw made, which the turn that drew it keeps (`keepDraw`).
  kept: DrawMemory;
} {
  const { sessionState, linkSigner, renderWarnings, effectSessions, menuIdle } =
    parts;
  const { req, readings, facts, sessionId, entry, state, view, hintsError } =
    setup;
  const { at } = readings;
  // [LAW:one-source-of-truth] When the idle period of the menus the session's
  // last draw showed began, on this draw's wall: what its flash is drawn from.
  const idleSince = menuIdle.since(sessionId, readings);
  // [LAW:no-ambient-temporal-coupling] The picks this draw settles in its own
  // turn, the one its slots and payload are read in: a pick that moved during
  // a request's wait is drawn as one snapshot of the new one.
  // [LAW:one-source-of-truth] Every globals field as the session's view
  // resolved it (src/renderer/session-source.ts) — the same struct its
  // payload's `*.effective` fields (what a trigger label says) are read
  // from, and renderOpts below (what actually renders). One resolution, two
  // readers, so a label can never disagree with the bar. The precedence
  // the resolver applies, and why each rung sits where it does, lives
  // with the chain (resolveEffectiveGlobals, and src/config/presets.ts).
  // [LAW:one-source-of-truth] The payload, the globals and the document are
  // derived from the request and the world state the renderer took in one
  // action, and what the draw takes of the client (its tmux pane, its width)
  // is read off the payload, so a draw never mixes a document with a request
  // it was not composed from.
  const payload = view.source.payload();
  const effective = view.source.effective();
  const failure = view.source.failure();
  const document = view.source.facts();
  // Which animation lanes this session's settings switch on, as drawn.
  const lanes = laneSwitches(effective);
  noteFacts(facts, {
    lanes: LANE_NAMES.filter((lane) => lanes[lane]).join(",") || "-",
    // The preset the session's settings resolve to, which the draw uses.
    preset: effective.preset,
  });
  // [LAW:one-source-of-truth] The width is `renderWidth` of the turn's hints —
  // the client's cols, else the default, less Claude Code's reserve — which
  // its payload carries as `term.cols`.
  const hints = view.source.hints();
  const width = payload.term.cols;
  noteFacts(facts, { width: String(width) });
  // [LAW:no-ambient-temporal-coupling] The click error dispatch held for this
  // session, at this draw's instant and for whom it draws: shown by every
  // render inside its hold, and past it by a request until an answer has
  // carried it.
  const clickHold = clickErrorAt(sessionState, sessionId, at, drawing.by);
  const clickShown =
    clickHold.kind === "held" || clickHold.kind === "owed"
      ? clickHold.error
      : null;
  // [LAW:single-enforcer] Each repository awaiting the user's answer asks,
  // in every session drawn from the entry, until one of them answers.
  const questions = repoQuestions(entry.snapshot.repo, sessionId, linkSigner);
  // What a load or a request could not honour: each its own message, named by
  // what it is about. A load's error is about the session's config, and a
  // drop about the file that wrote it, so their text may change under an open
  // viewer (an issue fixed) without becoming another message; a request's
  // refusal, its hints' and a click's are about exactly what their text says.
  // Each copies its own text, but a drop copies the prompt that fixes it.
  const sourced = (
    kind: DrawError["kind"],
    about: string,
    text: string | null | undefined,
  ): MaybeError => ({ kind, about, text, copy: text });
  const said = (kind: DrawError["kind"], text: string | null | undefined) =>
    sourced(kind, text ?? "", text);
  const errors: readonly DrawError[] = [
    said("refused-args", refusedArgsError(req.refusedArgs)),
    said("hints", hintsError),
    sourced("load", "load", entry.lastError),
    ...state.dropped.map(
      (e): MaybeError => ({
        kind: "dropped",
        subject: e.file,
        about: `dropped\0${e.file}`,
        text: e.message,
        copy: e.prompt,
      }),
    ),
    said("click", clickShown?.text),
  ].flatMap(({ about, text, copy, ...named }) =>
    about && text && copy ? [{ ...named, about, text, copy }] : [],
  );
  // What stands before the draw: whether the daemon can vouch that a config
  // edit reloads and that what it launches dies with it, what this config's
  // watch cannot hear, and the warning this config's load carried.
  // [LAW:no-silent-failure] A config whose link chain the host's watch cannot
  // walk, or whose folder the OS will not watch, may miss an edit: the bar
  // says so, as discovery found it. A stall is no reason of this watch's: it
  // has the bar's own row.
  const configWatch = entry.snapshot.watch;
  // [LAW:no-ambient-temporal-coupling] The launcher's warnings at this draw's
  // instant and for whom it draws, by the same event hold as the click error.
  const { daemon } = document;
  const launched = launcherWarningsAt(daemon.launcher, at, drawing.by);
  const pipeWarning = launched.find((w) => w.kind === "launch-pipes");
  const held = [
    daemonEventAt("renderer-ended", daemon.rendererEnded, at, drawing.by),
    daemonEventAt("act-failed", daemon.actFailed, at, drawing.by),
  ].flatMap((w) => (w === undefined ? [] : [w]));
  const eventsShown = [pipeWarning?.event, ...held.map((w) => w.event)].flatMap(
    (e) => (e === undefined ? [] : [e]),
  );
  const standing: readonly StandingWarning[] = [
    ...daemon.fileEvents,
    ...launched,
    ...held,
    ...(configWatch === null
      ? []
      : [{ kind: "config-watch" as const, message: configWatch }]),
    ...entry.lastWarnings.map((message) => ({
      kind: "load" as const,
      message,
    })),
    // [LAW:no-silent-failure] A turn that could not be stamped leaves the bar
    // drawn from the last one that was, so the bar says it is behind.
    ...(failure === null
      ? []
      : [
          {
            kind: "facts" as const,
            message: `the bar is drawn from the last facts that were read; the next could not be stamped: ${failure}`,
          },
        ]),
  ];
  // [LAW:one-source-of-truth] ONE list per draw, built before it: the door's
  // indicator reads it as the `diagnostics` projection and the viewer pages
  // the same object, so the two cannot disagree within a frame. The render
  // warnings are this renderer's recorded ones — known only after a walk, so
  // the frame before this one's — with every other renderer's for the
  // session (src/renderer/render-warnings.ts).
  const scope = { config: state.config };
  const diagnostics = collectDiagnostics(
    sessionId,
    drawing.by,
    errors,
    questions,
    [
      // A standing warning is one per kind whose words change as it does (a
      // pipe event's counts), so its kind alone is what it is about: a viewer
      // open on it stays open. A render warning is about its words.
      ...standing.map((w) => ({
        about: w.kind,
        text: w.message,
        copy: w.message,
      })),
      ...renderWarnings.ofSession(sessionId, drawing.by, scope).map((w) => ({
        about: `${w.kind}\0${w.message}`,
        text: w.message,
        copy: w.message,
      })),
    ],
  );
  const projected = {
    diagnostics: diagnosticsProjection(diagnostics),
    drawing,
    feeds,
    ...instantFacts(document.builtins, at),
  };
  const metrics = isPending(payload.metrics) ? undefined : payload.metrics;
  noteFacts(
    facts,
    sourcesFactOf(
      [...view.state.sources.keys()],
      view.registry.runSources(),
      document,
    ),
  );
  noteFacts(facts, {
    prompts: String(metrics?.messageCount ?? "-"),
    nonPrompts: String(metrics?.nonPrompts ?? "-"),
    pr: prFactOf(payload.git),
    feeds: feedsFact(projected.feeds),
  });
  // [LAW:one-source-of-truth] The options drawDsl draws with are the SAME
  // `effective` struct the payload was just built from, projected by the one
  // `renderOptionsOf` every renderer shares — no second `?? DEFAULT_X`
  // computation to drift from it.
  const renderOpts = renderOptionsOf(effective, width);
  const effects = effectSessions.of(sessionId);
  // [LAW:single-enforcer] The view's inputs read its source (`bindView`, at
  // its opening): the draw hands only its own instant's facts.
  // [LAW:no-silent-failure] What the walk had to settle for itself and could
  // not honour (`RenderWarning`) is this frame's own, recorded for its
  // renderer by the turn that keeps the frame, so the bar still renders and
  // the indicator counts them.
  const {
    frame,
    memory,
    warnings: drawnWarnings,
    segments,
    evaluated,
    cellBreaks,
    rules,
  } = drawDsl(
    state.config,
    state.compiled,
    view.store,
    view.registry,
    projected,
    at,
    renderOpts,
    // [LAW:one-source-of-truth] The draw's own settings, the session's
    // effect memory and the record of the surface's last frame of the view.
    // The theme, style and effect are not among them: the view's slots settle
    // those names (src/dsl/parts.ts), the same ones its payload's `.effective`
    // fields read.
    {
      ...effective,
      effects,
      record: view.frames.get(drawing.by),
      idleSince: idleSince ?? undefined,
    },
  );
  // [LAW:one-source-of-truth] What each copy click this frame mints copies,
  // read back when the click runs (the copy-diagnostic verb): the list this
  // renderer last delivered, never text carried in the link. Recorded when
  // the frame reaches its client, so a draw that throws, or an answer that
  // never arrives, leaves the shown frame's copies.
  const keys = copyKeys(diagnostics);
  const copies = new Map(diagnostics.map((m, i) => [keys[i]!, m.copy]));
  // [LAW:one-source-of-truth] The idle period this walk drew with.
  noteFacts(facts, {
    menuIdle:
      idleSince === null
        ? "-"
        : `${(at - idleSince).toFixed(1)}s/${effective.menuTimeout}s`,
  });
  // [LAW:no-silent-failure] Every frame records what it warned; a record that
  // moved is shown by the renderer's next frame: a feed's next spaced frame,
  // a request's next poll. Nothing wakes for it, since a frame whose own
  // indicator moves what it warns would wake itself forever.
  const recorded = renderWarnings.moves(sessionId, drawing.by, drawnWarnings);
  const geometry: DiagnosticGeometry = {
    width,
    rows: viewerRowCap(hints.termRows),
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
  const fx = memory.motion.frame;
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
      case "segment":
        return `segment:${w.placement}`;
      case "file-events":
        return `${w.kind}:${w.state}`;
      case "load":
      case "facts":
      case "config-watch":
      case "lifeline":
      case "launch-pipes":
      case "renderer-ended":
      case "act-failed":
      case "when":
        return w.kind;
    }
  };
  const warned = [...standing, ...drawnWarnings].map(tagOf).join(",") || "-";
  // [LAW:nothing-unseen] Every fault this frame met, each whole, at the level
  // the bar's list shows it: the errors, the warnings standing before the
  // draw and the walk's own warnings. Noted whole when
  // it moved since the renderer's last record of the session, so a reader
  // learns what the frame could not honour without its viewer, and `kept`
  // otherwise, so an unchanged bar costs no message per tick.
  const faults: ReadonlyArray<Fault<FaultKind>> = [
    ...errors.map((e) => faultOf("error", e.kind, e.text, e.subject)),
    ...standing.map((w) => faultOf("warning", w.kind, w.message)),
    ...drawnWarnings.map((w) =>
      faultOf("warning", w.kind, w.message, subjectOf(w)),
    ),
  ];
  noteFacts(facts, {
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
    // How many strip items dividing cells too wide for a line added.
    cellBreaks: String(cellBreaks),
    // The sources it drew as not answered yet; `-` for none.
    pending: body.pending.join(",") || "-",
    // Each globals rule in force, as its slot settled it: `kept` outside the
    // draw, `per-draw` at this frame's instant; `-` for none.
    rules: [...rules].map(([slot, how]) => `${slot}:${how}`).join(",") || "-",
    err: errors.length > 0 ? "Y" : "N",
    clickError: clickHold.kind === "none" ? "-" : clickHold.kind,
    // The launcher's pipe event as this frame showed it: `-` for not at all.
    pipeEvent: pipeWarning?.hold ?? "-",
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
    cellBreaks,
    clickShown,
    eventsShown,
    copies,
    lanes,
    kept: {
      session: sessionId,
      by: drawing.by,
      record: memory.record,
      motion: memory.motion,
      warnings: { scope, list: drawnWarnings, faults },
      // What this frame drew is what the session's idle close follows.
      menu: {
        tick: readings.tick,
        shown: frame.rows.some((row) => row.kind === "menu"),
        timeoutS: effective.menuTimeout,
      },
      segments,
    },
  };
}

// [LAW:effects-at-boundaries] What one draw of a session made beside its
// frame, as values: the draw writes none of it, so drawing the same frame
// twice from the same state and instant leaves the renderer as it found it.
export interface DrawMemory {
  readonly session: SessionId;
  readonly by: Drawing["by"];
  // The surface's record of what the frame drew, and the session's motion.
  readonly record: FrameRecord<RenderedLine>;
  readonly motion: SessionMotion;
  // What the frame warned, in the scope its renderer's record is kept in.
  readonly warnings: {
    readonly scope: RecordScope;
    readonly list: readonly RenderWarning[];
    // Every fault the frame met, as its turn record noted them.
    readonly faults: readonly Fault[];
  };
  // Whether the frame showed a menu, under the timeout its settings resolve
  // to, at the tick of the turn that drew it.
  readonly menu: {
    readonly tick: Tick;
    readonly shown: boolean;
    readonly timeoutS: number;
  };
  readonly segments: ReadonlyMap<string, readonly RichText[]>;
}

// [LAW:single-enforcer] The state machine's one store of a draw's memory,
// called by the turn that drew it once the draw returned: each piece to its
// one owner — the record on the view the draw read it from, the motion with
// the session — once the turn has nothing left to throw, so a frame that
// fails keeps nothing and the last frame's memory stands.
function keepDraw(
  parts: RendererParts,
  setup: RenderSetup,
  kept: DrawMemory,
): void {
  const { session, by, record, motion, warnings, menu, segments } = kept;
  const { view } = setup;
  view.frames.set(by, record);
  view.lastRenderCellsBySegment = segments;
  parts.effectSessions.keep(session, motion);
  // [LAW:single-enforcer] The faults are noted as their record is kept, so a
  // frame that throws notes none.
  noteFacts(setup.facts, {
    faults: parts.renderWarnings.keep(
      session,
      by,
      warnings.scope,
      warnings.list,
      warnings.faults,
    ),
  });
  parts.menuIdle.drew(session, menu.tick, menu.shown, menu.timeoutS);
}

// [LAW:types-are-the-program] What each error a draw lists is, named once:
// the kind its fault is noted by, and the file a dropped write names.
interface DrawError extends SourcedText {
  readonly kind: "refused-args" | "hints" | "load" | "dropped" | "click";
  readonly subject?: string;
}

// An error as its producer hands it, before an empty text drops it.
type MaybeError = Omit<DrawError, "text" | "copy"> & {
  readonly text: string | null | undefined;
  readonly copy: string | null | undefined;
};

// [LAW:one-source-of-truth] Every kind a fault is noted by, derived from the
// producers' own unions, so a new kind of warning or error is a fault's kind
// with no list here to extend.
type FaultKind =
  | DrawError["kind"]
  | StandingWarning["kind"]
  | RenderWarning["kind"];

const faultOf = (
  level: Fault["level"],
  kind: FaultKind,
  message: string,
  subject?: string,
): Fault<FaultKind> => ({ level, kind, subject, message });

// What a walk's warning is about, where it carries one.
// [LAW:types-are-the-program] Exhaustive over the kinds, as `tagOf` is.
function subjectOf(w: RenderWarning): string {
  switch (w.kind) {
    case "rule":
      return w.slot;
    case "refresh":
      return w.variable;
    case "segment":
      return w.placement;
    case "when":
      return w.where;
  }
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

// The facts the bar is drawn from are behind: the latest turn could not be
// stamped.
interface FactsWarning {
  readonly kind: "facts";
  readonly message: string;
}

// [LAW:no-silent-failure] A renderer process that ended took its session
// state that lives only in memory with it (open menus, armed confirms): the
// bar the next one draws says so, by the same event hold as a pipe event. So
// does an act that failed where no session's bar could hold it.
interface DaemonEventWarning {
  readonly kind: "renderer-ended" | "act-failed";
  readonly message: string;
  readonly event: HeldEvent;
}

function daemonEventAt(
  kind: DaemonEventWarning["kind"],
  event: HeldEvent | null,
  at: Instant,
  render: Drawing["by"],
): DaemonEventWarning | undefined {
  return event === null ||
    eventHoldAt(event, DAEMON_EVENT_HOLD_S, at, render) === "over"
    ? undefined
    : { kind, message: event.text, event };
}

// What stands before a draw, whatever the draw then meets.
type StandingWarning =
  | FileEventsWarning
  | LauncherWarning
  | DaemonEventWarning
  | ConfigWatchWarning
  | LoadWarning
  | FactsWarning;

// What one render drew: the body — the bar, or the viewer in its place — and
// what the statusline's handoff line is drawn from: whether the body is the
// viewer, the draw's one diagnostic list, and the geometry.
interface DrawnBar {
  readonly body: Frame;
  readonly viewerOpen: boolean;
  readonly diagnostics: DiagnosticList;
  readonly geometry: DiagnosticGeometry;
}

// A render request's answer: the bar drawn for its client.
export interface RequestAnswer {
  // What this request's client is shown: the statusline's frame to Claude
  // Code's statusline, the bar to a client drawing it itself.
  readonly frame: Frame;
  // What to record once that frame reached its client (`deliver`).
  readonly delivery: Delivery;
}

export function answerRequest(
  parts: RendererParts,
  req: CheckedRenderRequest,
  facts: RequestFacts,
  // The request's turn's effects, which the setups its session's clicks owe
  // join.
): RequestAnswer {
  const { time, feeds } = parts;
  using setup = setUpRender(
    parts,
    req,
    { at: time.at, tick: time.tick },
    facts,
  );
  const sessionId = req.hookData.session_id;
  const { drawn, clickShown, eventsShown, copies, lanes, kept } = drawRender(
    parts,
    setup,
    ANSWERING,
    feeds.feedsOf(sessionId, time.tick),
  );
  const elsewhere = handedOffTo(lanes, feeds.following(sessionId));
  // A `frames` display draws the bar itself; Claude Code's statusline hands
  // it to the lanes drawing it elsewhere.
  const toStatusline = roleOf(req.hints.client ?? null) === "statusline";
  // [LAW:single-enforcer] Signed as it leaves the renderer, each link once.
  const frame = signingFrames(parts.linkSigner)(
    toStatusline
      ? statuslineOf(sessionId, setup.state.writable, drawn, elsewhere)
      : drawn.body,
  );
  // Kept once nothing of the turn is left to throw.
  keepDraw(parts, setup, kept);
  // [LAW:nothing-unseen] Which lanes the statusline handed the bar to. How
  // long the turn took is the host's `drew=`, timed around the turn.
  noteFacts(facts, {
    handoff: (toStatusline ? elsewhere : []).join(",") || "-",
  });
  return {
    frame,
    delivery: {
      session: sessionId,
      by: ANSWERING.by,
      copies,
      clickShown,
      eventsShown,
    },
  };
}

// What a frame that reached its client showed, which its delivery records:
// what its copy clicks copy, and the click error and the held events it
// carried.
export interface Delivery {
  readonly session: SessionId;
  readonly by: Drawing["by"];
  readonly copies: ReadonlyMap<string, string>;
  readonly clickShown: ClickErrorRecord | null;
  readonly eventsShown: readonly HeldEvent[];
}

// [LAW:single-enforcer] The one record of a delivery. An answer carrying the
// click error or a daemon-wide held event that reaches its client is the one
// that delivered it (src/utils/event-hold.ts).
export function deliver(parts: RendererParts, delivery: Delivery): void {
  const { session, by, copies, clickShown, eventsShown } = delivery;
  parts.renderCache.delivered(session, by, copies);
  if (clickShown !== null)
    answeredClickError(parts.sessionState, session, clickShown);
  // Daemon-wide: one session's answer having shown the event is what makes
  // it not silent.
  for (const event of eventsShown) parts.eventAnswered(event);
}

// What Claude Code's statusline shows of `drawn`: the bar, or — while lanes
// draw it `elsewhere` — the handoff line, which says where, with the bar's
// indicator after it. [LAW:one-source-of-truth] The indicator reads the draw's
// one list, and its click opens the one viewer: while it is open the statusline
// shows it, the same body the lanes draw.
function statuslineOf(
  sessionId: SessionId,
  writable: readonly LayerRole[],
  drawn: DrawnBar,
  elsewhere: readonly Lane[],
): Frame {
  const [first, ...rest] = elsewhere;
  return first === undefined || drawn.viewerOpen
    ? drawn.body
    : standIn(
        drawn.body,
        handoffRows(
          laneHandoff(sessionId, writable, [first, ...rest]),
          drawn.diagnostics,
          sessionId,
          drawn.geometry,
        ),
      );
}
