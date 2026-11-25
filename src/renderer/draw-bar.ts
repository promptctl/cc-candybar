// One render of a session, a request's or a frame's, and what it records.

import type { FileEventsWarning } from "../daemon/foundations/file-events-warnings";
import type { LifelineWarning } from "../proc/launcher";
import type { StoreUnsavedWarning } from "../daemon/foundations/stored-file";
import {
  DAEMON_EVENT_HOLD_S,
  eventHoldAt,
  type DaemonEvent,
  type EventHold,
} from "../utils/event-hold.js";
import { type CheckedRenderRequest } from "../renderer-interface/request-context.js";
import {
  refusedHints,
  refusedArgsError,
  refusedHintsError,
  type ClientHints,
} from "../daemon/foundations/protocol";
import { type SessionId } from "../daemon/foundations/session-id";
import type { EffectId } from "../renderer-interface/interface";
import { repoQuestions } from "../config/repo-question";
import {
  writableRoles,
  type CacheEntry,
  type RenderCache,
  type DslRenderState,
  type SessionHold,
  type SessionView,
} from "./render-cache";
import { roleOf } from "../daemon/foundations/sighting-roles";
import { partsOf } from "../dsl/parts.js";
import { drawDsl, type RenderWarning } from "../dsl/render.js";
import { standIn, type Frame } from "../render/frame.js";
import {
  renderOptionsOf,
  renderWidth,
  prFactOf,
  sourceFieldsOf,
  sourceSummaryOf,
  instantFacts,
} from "./render-payload.js";
import { type SessionSource } from "./session-source.js";
import { runInAction } from "mobx";
import type { WorldStates } from "./world-states.js";
import { awaitingOf, type Awaiting } from "../facts/awaited.js";
import { transcriptLossText, type WorldState } from "../facts/world-state.js";
import type { PendingRead } from "../var-system/types.js";
import { isPending } from "../utils/outcome.js";
import {
  editGlobalsOf,
  laneSwitches,
  resolveEffectiveGlobals,
} from "../config/effective-globals.js";
import type { PassageFrame } from "../render/effect.js";
import {
  feedsFact,
  LANES,
  LANE_NAMES,
  perLane,
  ANSWERING,
  type Drawing,
  type Lane,
  type LaneFeeds,
  type LaneSwitches,
} from "../config/lanes.js";
import type { Fault } from "../renderer-interface/noted-faults.js";
import type { PanePointer } from "../click/gesture.js";
import { pointerFacts, surfaceOf } from "../render/pointer-facts.js";
import { inClickMode } from "../render/click-mode-frame.js";
import {
  CLICK_MODE_KEY,
  HOVER_KEY,
  modeInForce,
  modeIsOpen,
} from "../config/click-mode.js";
import type { FeedDraw, Feeds } from "./feeds.js";
import type { TurnTime } from "./turn-time.js";
import {
  answeredClickError,
  clickErrorAt,
  type ClickErrorRecord,
} from "../daemon/foundations/click-error.js";
import { handedOffTo, laneHandoff } from "./lane-handoff.js";
import {
  aboutKind,
  aboutSubject,
  aboutText,
  type About,
} from "../config/about.js";
import { loadAbout } from "../config/loader/diagnostics.js";
import {
  collectDiagnostics,
  diagnosticCopies,
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
import { type Instant, type Readings } from "../utils/instant.js";
import {
  drawEvent,
  noteFacts,
  type RequestFacts,
} from "../daemon/foundations/request-event.js";

import type { SessionStateRW } from "../renderer-interface/session-state.js";
import {
  describeWarning,
  frameWarnings,
  warningChanges,
} from "./render-warnings.js";
import type { Acceptance, FrameCandidate } from "./presented-frames.js";
import { rendererFailureOf } from "../daemon/foundations/verb-error.js";
import { renderFailure } from "../daemon/foundations/render-answers";

// The renderer's own state, including the world state its views were handed.
export interface RendererParts {
  // The turn's time, handed in by the host: no draw reads a clock.
  readonly time: TurnTime;
  readonly sessionState: SessionStateRW;
  readonly renderCache: RenderCache<SessionSource, CheckedRenderRequest>;
  readonly worldStates: WorldStates;
  // What the feeds know of who watches each session, which a request's
  // answer hands the bar to and shows the rate of.
  readonly feeds: Pick<Feeds, "following" | "feedsOf">;
}

// One frame of a subscribed session, drawn from its latest request at this
// instant, by the render a request gets. The host presents the bar or its
// statusline handoff, and the bar moves when its effects say it does.
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
  // What the pane that owns the session's pointer says of it, if one does.
  pointer: PanePointer | null,
  prepare: PrepareDelivery,
): FeedDraw | null {
  const facts: RequestFacts = [];
  try {
    using setup = setUpFrame(parts, sessionId, readings, facts);
    if (setup === null) return null;
    const { drawn, evaluated, cellBreaks, lanes, candidate, eventsShown } =
      drawRender(parts, setup, { by: "feed", fps }, feeds, pointer);
    const bar = drawn.body;
    const { frame: statusline } = statuslineOf(
      setup,
      parts.sessionState,
      drawn,
      handedOffTo(lanes, following),
    );
    const handoff = statusline === bar ? null : statusline;
    const receipt = prepare({
      candidate,
      clickShown: null,
    });
    return {
      frame: {
        kind: "drawn",
        receipt,
        bar,
        handoff,
        displayedEvents: eventsShown,
      },
      evaluated,
      cellBreaks,
      failure: null,
    };
  } catch (error) {
    const outcome = renderFailure(rendererFailureOf(error));
    const { level, line } = drawEvent("render", facts, outcome);
    return {
      frame: { kind: "failed", message: outcome.message },
      evaluated: 0,
      cellBreaks: 0,
      failure: { level, line: `frame ${line}` },
    };
  }
}

// The committed lane settings for a session with a live view. The draft
// can replace what the view draws while the host follows committed config.
export function viewLanes(
  parts: RendererParts,
  sessionId: SessionId,
  committed: {
    readonly settings: SessionStateRW;
    readonly state: DslRenderState;
  } | null,
): LaneSwitches | null {
  const { renderCache } = parts;
  using hold = renderCache.holdView(sessionId);
  if (hold === null) return null;
  if (committed === null) return laneSwitches(hold.view.source.effective());

  // [LAW:effects-at-boundaries] Only committed settings declare a live
  // host surface. A draft changes the bar's preview until Save lands.
  const { config, authoredRoots } = committed.state;
  return laneSwitches(
    resolveEffectiveGlobals(
      config,
      (key) => committed.settings.get(sessionId, key),
      (preset) => authoredRoots.has(preset),
    ),
  );
}

type TerminalSize = Pick<ClientHints, "termCols" | "termRows">;

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
  readonly terminal?: TerminalSize;
}

// What a render notes of the context it draws by.
export function contextFacts(
  req: CheckedRenderRequest,
  facts: RequestFacts,
): void {
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
    // statusline diagnostics retain (RenderSightings).
    rateLimits: req.rateLimits,
  });
}

// The error message for the hints the context refused.
//
// [LAW:parse-dont-validate] The ONE checkpoint for everything the client
// observed and the daemon cannot. Raw `req.*` hint fields are not read past
// this line; `hints` is the stamped type the render path consumes.
//
// The host combined the live terminal observations with facts from the
// session's environment. The renderer sees the resulting hints.
const hintsErrorOf = (req: CheckedRenderRequest): string | null =>
  refusedHintsError(refusedHints(req, req.hints));

// The session's view opened at the context, and let go: what a `context`
// waits for its origin's config to do.
export function openSession(parts: RendererParts, session: SessionId): void {
  holdSessionAt(parts, parts.worldStates.requestOf(session))[Symbol.dispose]();
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
// `context` turn opens it ahead of the request. If the cache evicts the
// view before the request draws, the request can open it again at the live context.
function holdSessionAt(
  parts: RendererParts,
  req: CheckedRenderRequest,
): SessionHold<SessionSource, CheckedRenderRequest> {
  // [LAW:one-source-of-truth] The explicit config path has two spellings and
  // ONE precedence: the `--config` flag over the client's `CC_CANDYBAR_CONFIG`
  // hint (checkRenderRequest). Both are client facts; the daemon's own env is
  // never consulted.
  return parts.renderCache.holdSession(req.requested, req);
}

export function setUpRender(
  parts: RendererParts,
  req: CheckedRenderRequest,
  readings: Readings,
  facts: RequestFacts,
  terminal?: TerminalSize,
): RenderSetup {
  // [LAW:no-ambient-temporal-coupling] Held, not fetched: `state`, and the
  // session's `view` of it, are what this render resolves its payload from and
  // draws with after the payload await below. An eviction, a reload, or the
  // session's own render from another entry meanwhile retires them, and the
  // cache disposes them when this hold is released — never under the render.
  // The setup owns the hold from here: a throw before it is returned releases
  // it, and the setup releases it on every exit of the render that disposes
  // it. Its facts and its world state came with its `context`.
  const hintsError = hintsErrorOf(req);
  const hold = holdSessionAt(parts, req);
  return setUpDraw(parts, hold, req, hintsError, readings, facts, terminal);
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
  // [LAW:no-ambient-temporal-coupling] Every read after the hold is taken
  // releases it on a throw, the view's request included.
  let req: CheckedRenderRequest;
  let hintsError: string | null;
  try {
    req = hold.view.facts();
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
  terminal?: TerminalSize,
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
      terminal,
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
  // The pointer of the pane that owns the session's, which only a fed bar has:
  // the request path draws for no pointer of its own.
  pointer: PanePointer | null,
): {
  drawn: DrawnBar;
  evaluated: number;
  cellBreaks: number;
  clickShown: ClickErrorRecord | null;
  // The daemon's events this draw showed (each pipe event, the last
  // renderer's end, an act that failed, a task that threw), which an answer
  // carrying them marks answered.
  eventsShown: readonly DaemonEvent[] | undefined;
  // Which animation lanes the session's settings switch on, as drawn.
  lanes: LaneSwitches;
  candidate: FrameCandidate;
} {
  const {
    sessionState,
    renderCache: { presentations },
  } = parts;
  const { req, readings, facts, sessionId, entry, state, view, hintsError } =
    setup;
  const { at } = readings;
  // [LAW:one-source-of-truth] When the idle period of the menus the session's
  // last draw showed began, on this draw's wall: what its flash is drawn from.
  const idleSince = presentations.menuIdle.since(sessionId, readings);
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
  // derived from the context and the world state the renderer took together.
  // A request's own terminal size is a presentation input; action targets
  // and source readings stay tied to the session's live context.
  const payload = view.source.payload();
  const effective = view.source.effective();
  const failure = view.source.failure();
  const document = view.source.facts();
  // Which animation lanes this session's settings switch on, as drawn.
  const lanes = laneSwitches(effective);
  const configAccess = view.configAccess();
  noteFacts(facts, {
    lanes: LANE_NAMES.filter((lane) => lanes[lane]).join(",") || "-",
    // The preset the session's settings resolve to, which the draw uses.
    preset: effective.preset,
  });
  const { terminal } = setup;
  const width =
    terminal === undefined ? payload.term.cols : renderWidth(terminal);
  const rows = viewerRowCap((terminal ?? view.source.hints()).termRows);
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
  const questions = repoQuestions(entry.revision.snapshot.repo, sessionId);
  // What a load or a request could not honour: each its own message. A
  // request's refusal, its hints' and a click's are about exactly what their
  // text says, and an absent report is no message.
  const said = (
    kind: DrawErrorKind,
    text: string | null | undefined,
  ): readonly DrawError[] =>
    text == null ? [] : [{ about: aboutText(kind, text), text, copy: text }];
  const { daemon } = document;
  // [LAW:no-ambient-temporal-coupling] The daemon's events at this draw's
  // instant and for whom it draws, by the same event hold as the click error.
  const daemonEvents = daemonEventsAt(daemon.held, at, drawing.by);
  const threw = daemonEvents.filter(isThrew);
  const errors: readonly DrawError[] = [
    ...said("refused-args", refusedArgsError(req.refusedArgs)),
    ...said("hints", hintsError),
    // A load's error is about the session's config, and a drop about the file
    // that wrote it, so their text may change under an open viewer (an issue
    // fixed) without becoming another message. A drop copies the prompt that
    // fixes it.
    ...(configAccess.kind === "unavailable"
      ? [
          {
            about: aboutKind("load"),
            text: configAccess.error,
            copy: configAccess.error,
          },
        ]
      : []),
    ...state.dropped.map(
      (e): DrawError => ({
        about: aboutSubject("dropped", e.file),
        text: e.message,
        copy: e.prompt,
      }),
    ),
    ...said("click", clickShown?.text),
    // [LAW:no-silent-failure] A daemon task that threw is a fault in the
    // daemon, an error on every bar. Each task is one message about itself,
    // however often it threw.
    ...threw.map(
      ({ shown }): DrawError => ({
        about: aboutSubject("task-threw", shown.about),
        text: shown.event.text,
        copy: shown.event.text,
      }),
    ),
  ];
  // What stands before the draw: whether the daemon can vouch that a config
  // edit reloads and that what it launches dies with it, what this config's
  // watch cannot hear, and the warning this config's load carried.
  // [LAW:no-silent-failure] A config whose link chain the host's watch cannot
  // walk, or whose folder the OS will not watch, may miss an edit: the bar
  // says so, as discovery found it. A stall is no reason of this watch's: it
  // has the bar's own row.
  const configWatch = entry.revision.snapshot.watch;
  // [LAW:one-source-of-truth] Acknowledgement comes from world state. The
  // warning's display hold still runs after the host has confirmed it.
  const eventsShown: readonly DaemonEvent[] = daemonEvents
    .map(({ shown }) => shown)
    .filter(({ event }) => !event.answered);
  const daemonWarnings = daemonEvents.filter(isWarned).map(
    ({ shown, hold }): Standing<DaemonEventWarning> => ({
      warning: { kind: shown.kind, message: shown.event.text, hold },
      about: aboutSubject(shown.kind, shown.about),
    }),
  );
  const standing: readonly Standing[] = [
    ...daemon.fileEvents.map(alone),
    ...(daemon.launcher === null ? [] : [alone(daemon.launcher)]),
    ...daemon.unsaved.map(
      (warning): Standing => ({
        warning,
        about: aboutSubject(warning.kind, warning.file),
      }),
    ),
    ...daemonWarnings,
    ...(configWatch === null
      ? []
      : [alone({ kind: "config-watch", message: configWatch })]),
    // [LAW:one-source-of-truth] A load's warnings arrive about what their
    // producer knew, so fixing one leaves another's identity put whatever
    // its words (a line number) become.
    ...entry.lastWarnings.map(
      ({ subject, message }): Standing => ({
        warning: { kind: "load", message },
        about: loadAbout(subject),
      }),
    ),
    // [LAW:no-silent-failure] A turn that could not be stamped leaves the bar
    // drawn from the last one that was, so the bar says it is behind.
    ...(failure === null
      ? []
      : [
          alone({
            kind: "facts",
            message: `the bar is drawn from the last facts that were read; the next could not be stamped: ${failure}`,
          }),
        ]),
    // [LAW:no-silent-failure] What the session's transcripts gave its folds
    // less of is missing from the bar's figures for it, so the bar says so
    // for as long as the folds that lack it hold the figures. Each file is
    // one message.
    ...document.transcriptLosses.map(
      (loss): Standing => ({
        warning: { kind: "transcript", message: transcriptLossText(loss) },
        about: aboutSubject("transcript", loss.path),
      }),
    ),
  ];
  // [LAW:one-source-of-truth] ONE list per draw, built before it: the door's
  // indicator reads it as the `diagnostics` projection and the viewer pages
  // the same object, so the two cannot disagree within a frame. Walk warnings
  // come from the session's accepted frame on this surface and the other
  // surface's accepted frame on the same config.
  const config = presentations.configOf(state.config);
  const target = view.presentationTargets[drawing.by];
  const diagnostics = collectDiagnostics(
    sessionId,
    drawing.by,
    errors,
    questions,
    [
      ...standing.map(({ about, warning }) => ({
        about,
        text: warning.message,
        copy: warning.message,
      })),
      // A render warning is about its whole description.
      ...presentations
        .warnings(sessionId, drawing.by, config)
        .map(({ key, warning }) => ({
          about: aboutText(warning.kind, key),
          text: warning.message,
          copy: warning.message,
        })),
    ],
  );
  // [LAW:one-source-of-truth] The mode this draw is in, once: the session's,
  // unless the surface of the pane that owns the pointer (a link's, with none)
  // delivers its gesture itself. Hover, the frame's links and whether the idle
  // clock runs all read this one value; the idle close resets the session's
  // own, which is what a lane that does not deliver the gesture reads.
  const mode = modeInForce(
    sessionState.get(sessionId, CLICK_MODE_KEY),
    surfaceOf(pointer),
  );
  const projected = {
    diagnostics: diagnosticsProjection(diagnostics),
    drawing,
    feeds,
    ...pointerFacts(pointer, mode, sessionState.get(sessionId, HOVER_KEY)),
    ...instantFacts(document.builtins, at),
  };
  const metrics = isPending(payload.metrics) ? undefined : payload.metrics;
  const sources = sourceSummaryOf(
    [...view.state.sources.keys()],
    view.registry.runSources(),
    document,
  );
  noteFacts(facts, sourceFieldsOf(sources));
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
  const effects = presentations.effects(sessionId);
  // [LAW:single-enforcer] The view's inputs read its source (`bindView`, at
  // its opening): the draw hands only its own instant's facts.
  // [LAW:no-silent-failure] What the walk had to settle for itself and could
  // not honour (`RenderWarning`) is this frame's own, recorded for its
  // renderer by the turn that keeps the frame, so the bar still renders and
  // the indicator counts them.
  const draw = () =>
    drawDsl(
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
        record: presentations.layout(sessionId, drawing.by, target)?.record,
        idleSince: idleSince ?? undefined,
      },
    );
  // [LAW:one-source-of-truth] Template term.cols and the physical strip use
  // the same width, including a client whose request waited through a resize.
  const {
    frame: drawnFrame,
    waited,
    memory,
    warnings: drawnWarnings,
    segments,
    evaluated,
    cellBreaks,
    rules,
  } = width === payload.term.cols
    ? draw()
    : partsOf(state.compiled, view.store).withTerminalWidth(width, draw);
  // [LAW:one-source-of-truth] What each copy click this frame mints copies,
  // read back when the click runs (the copy-diagnostic verb): the list this
  // renderer last delivered, never text carried in the link. Recorded when
  // the frame reaches its client, so a draw that throws, or an answer that
  // never arrives, leaves the shown frame's copies.
  const copies = diagnosticCopies(diagnostics);
  // [LAW:single-enforcer] The one place the click mode picks the links a frame
  // shows: a cell is drawn once, so no cell reads the mode
  // (src/render/click-mode-frame.ts).
  const frame = inClickMode(drawnFrame, mode);
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
  const geometry: DiagnosticGeometry = {
    width,
    rows,
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
  const warnings = drawnWarnings.map(describeWarning);
  const warned =
    [
      ...standing.map(({ warning }) =>
        warning.kind === "file-events"
          ? `${warning.kind}:${warning.state}`
          : warning.kind,
      ),
      ...warnings.map(({ tag }) => tag),
    ].join(",") || "-";
  // [LAW:nothing-unseen] Every fault this frame met, each whole, at the level
  // the bar's list shows it: the errors, the warnings standing before the
  // draw and the walk's own warnings. Noted whole when
  // it moved since the renderer's last record of the session, so a reader
  // learns what the frame could not honour without its viewer, and `kept`
  // otherwise, so an unchanged bar costs no message per tick.
  const faults: ReadonlyArray<Fault<FaultKind>> = [
    ...errors.map(({ about, text }) => faultAbout("error", about, text)),
    ...standing.map(({ about, warning }) =>
      faultAbout("warning", about, warning.message),
    ),
    ...warnings.map(({ warning, subject }) =>
      faultOf("warning", warning.kind, warning.message, subject),
    ),
  ];
  const diagnosticsRecord = frameWarnings(warnings, faults);
  const change = warningChanges(
    diagnosticsRecord,
    presentations.diagnostics(sessionId, drawing.by),
  );
  noteFacts(facts, {
    faults: change.faults,
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
    // Each pipe event as this frame showed it, in the order held: `-` for
    // none at all.
    pipeEvent:
      daemonWarnings
        .filter(({ warning }) => warning.kind === "launch-pipes")
        .map(({ warning }) => warning.hold)
        .join(",") || "-",
    // How many repositories the bar asked about.
    ask: String(questions.length),
    warn: warned,
    // What the indicator counted, and whether this frame's warnings moved
    // its renderer's record (`new`) or matched it (`kept`).
    diag: String(diagnostics.length),
    warnRecord: change.moved ? "new" : "kept",
    // The message the viewer showed in the body's place, `-` while closed.
    viewer:
      viewing === null
        ? "-"
        : `${viewing.index}/${diagnostics.length}p${viewing.page + 1}`,
  });
  return {
    drawn: {
      body,
      // What the body drew as not answered yet, and the document it drew
      // from; a viewer standing in for the body drew none.
      waited: viewing === null ? waited : [],
      document,
      viewerOpen: viewing !== null,
      diagnostics,
      geometry,
    },
    evaluated,
    cellBreaks,
    clickShown,
    eventsShown: eventsShown.length > 0 ? eventsShown : undefined,
    lanes,
    candidate: {
      session: sessionId,
      by: drawing.by,
      target,
      frame: {
        config,
        layout: { record: memory.record, segments },
        motion: memory.motion,
        diagnostics: diagnosticsRecord,
        copies,
        menu: {
          tick: readings.tick,
          // [LAW:no-ambient-temporal-coupling] A click mode the user left on
          // is open state as a menu is: the same idle period ends it.
          shown:
            frame.rows.some((row) => row.kind === "menu") || modeIsOpen(mode),
          timeoutS: effective.menuTimeout,
        },
      },
    },
  };
}

// [LAW:types-are-the-program] What each error a draw lists is, named once:
// the kind its fault is noted by, and what it is about: the file a dropped
// write names, or the task that threw.
type DrawErrorKind =
  | "refused-args"
  | "hints"
  | "load"
  | "dropped"
  | "click"
  | "task-threw";
interface DrawError extends SourcedText {
  readonly about: About<DrawErrorKind>;
}

// [LAW:one-source-of-truth] Every kind a fault is noted by, derived from the
// producers' own unions, so a new kind of warning or error is a fault's kind
// with no list here to extend.
type FaultKind =
  | DrawErrorKind
  | StandingWarning["kind"]
  | RenderWarning["kind"];

const faultOf = (
  level: Fault["level"],
  kind: FaultKind,
  message: string,
  subject?: string,
): Fault<FaultKind> => ({ level, kind, subject, message });

// [LAW:one-source-of-truth] An error's fault is noted by the about its viewer
// message carries, so the two cannot name different ones.
const faultAbout = (
  level: Fault["level"],
  about: About<FaultKind>,
  message: string,
): Fault<FaultKind> =>
  faultOf(
    level,
    about.kind,
    message,
    about.rule === "subject" ? about.subject : undefined,
  );

// [LAW:one-type-per-behavior] A standing warning that is its message alone:
// the warning a load carried, beside what a draw could not honour
// (`load`); what the config's watch cannot hear, so an edit may not reload
// (`config-watch`); the facts the bar is drawn from being behind, the latest
// turn not stamped (`facts`); and what a transcript gave the session's folds
// less of (`transcript`).
interface MessageWarning {
  readonly kind: "load" | "config-watch" | "facts" | "transcript";
  readonly message: string;
}

type ThrewEvent = Extract<DaemonEvent, { kind: "task-threw" }>;

// A daemon event a draw shows, and why: inside the hold, or owed past it.
interface ShownDaemonEvent<Event extends DaemonEvent = DaemonEvent> {
  readonly shown: Event;
  readonly hold: Exclude<EventHold, "over">;
}

// [LAW:single-enforcer] Which of the daemon's events is an error: a task that
// threw is a fault in the daemon, where each other event is a warning.
const isThrew = (
  event: ShownDaemonEvent,
): event is ShownDaemonEvent<ThrewEvent> => event.shown.kind === "task-threw";
const isWarned = (
  event: ShownDaemonEvent,
): event is ShownDaemonEvent<Exclude<DaemonEvent, ThrewEvent>> =>
  !isThrew(event);

// [LAW:single-enforcer] Which of the daemon's events a render shows: by the
// one hold every event of the daemon's own is held by.
function daemonEventsAt(
  held: readonly DaemonEvent[],
  at: Instant,
  render: Drawing["by"],
): ShownDaemonEvent[] {
  return held.flatMap((shown) => {
    const hold = eventHoldAt(shown.event, DAEMON_EVENT_HOLD_S, at, render);
    return hold === "over" ? [] : [{ shown, hold }];
  });
}

// [LAW:no-silent-failure] The daemon's own events that warn: a launched
// program's pipe that outlived its launch, one warning per what it met; a
// renderer process that ended, taking the session state that lives only in
// memory with it (open menus, armed confirms), so the bar the next one draws
// says so; and an act that failed where no session's bar could hold it.
interface DaemonEventWarning {
  readonly kind: Exclude<DaemonEvent, ThrewEvent>["kind"];
  readonly message: string;
  readonly hold: ShownDaemonEvent["hold"];
}

// What stands before a draw, whatever the draw then meets.
type StandingWarning =
  | FileEventsWarning
  | LifelineWarning
  | StoreUnsavedWarning
  | DaemonEventWarning
  | MessageWarning;

// A standing warning and what it is about: a kind that recurs (a pipe event's
// count, a load's file) is about its subject, so its words change while it
// stays one message.
interface Standing<Warning extends StandingWarning = StandingWarning> {
  readonly warning: Warning;
  readonly about: About<StandingWarning["kind"]>;
}

const alone = (warning: StandingWarning): Standing => ({
  warning,
  about: aboutKind(warning.kind),
});

// What one render drew: the body — the bar, or the viewer in its place — and
// what the statusline's handoff line is drawn from: whether the body is the
// viewer, the draw's one diagnostic list, and the geometry.
interface DrawnBar {
  readonly body: Frame;
  readonly waited: readonly PendingRead[];
  readonly document: WorldState;
  readonly viewerOpen: boolean;
  readonly diagnostics: DiagnosticList;
  readonly geometry: DiagnosticGeometry;
}

// A render request's answer: the bar drawn for its client.
export interface RequestAnswer {
  // What this request's client is shown: the statusline's frame to Claude
  // Code's statusline, the bar to a client drawing it itself.
  readonly frame: Frame;
  readonly displayedEvents?: readonly DaemonEvent[];
  // [LAW:single-enforcer] What the frame still owes, said by the draw that
  // made it: the one thing the host's wait reads (src/facts/awaited.ts).
  readonly awaiting: Awaiting;
  // What to record once that frame reached its client (`deliver`).
  readonly delivery: Delivery;
}

export function answerRequest(
  parts: RendererParts,
  req: CheckedRenderRequest,
  presentation: TerminalSize & Pick<ClientHints, "client">,
  facts: RequestFacts,
): RequestAnswer {
  const { time, feeds } = parts;
  const sessionId = req.hookData.session_id;
  using setup = setUpRender(
    parts,
    req,
    { at: time.at, tick: time.tick },
    facts,
    presentation,
  );
  const { drawn, clickShown, eventsShown, lanes, candidate } = drawRender(
    parts,
    setup,
    ANSWERING,
    feeds.feedsOf(sessionId, time.tick),
    null,
  );
  const elsewhere = handedOffTo(lanes, feeds.following(sessionId));
  // A `frames` display draws the bar itself; Claude Code's statusline hands
  // it to the lanes drawing it elsewhere.
  const toStatusline = roleOf(presentation.client ?? null) === "statusline";
  const { frame, waited } = toStatusline
    ? statuslineOf(setup, parts.sessionState, drawn, elsewhere)
    : { frame: drawn.body, waited: drawn.waited };
  // [LAW:nothing-unseen] Which lanes the statusline handed the bar to. How
  // long the turn took is the host's `drew=`, timed around the turn.
  noteFacts(facts, {
    handoff: (toStatusline ? elsewhere : []).join(",") || "-",
  });
  const awaiting = awaitingOf(waited, drawn.document);
  // [LAW:nothing-unseen] What the frame owes, by name; `-` for nothing.
  noteFacts(facts, {
    owed: awaiting.kind === "settled" ? "-" : awaiting.names.join(","),
  });
  return {
    frame,
    displayedEvents: eventsShown,
    awaiting,
    delivery: {
      candidate,
      clickShown,
    },
  };
}

// What a frame that reached its client showed, which its delivery records:
// what its copy clicks copy and the session's click error.
export interface Delivery {
  readonly candidate: FrameCandidate;
  readonly clickShown: ClickErrorRecord | null;
}

export type PrepareDelivery = (delivery: Delivery) => EffectId;

// [LAW:single-enforcer] Only the current surface's accepted receipt may
// commit the renderer's layout or answer its session's click error.
export function deliver(
  parts: RendererParts,
  id: EffectId,
  delivery: Delivery,
): Acceptance | null {
  const { candidate, clickShown } = delivery;
  const accepted = parts.renderCache.acceptFrame(id, candidate);
  if (accepted === null) return null;
  if (clickShown !== null)
    answeredClickError(parts.sessionState, candidate.session, clickShown);
  return accepted;
}

// What Claude Code's statusline shows of `drawn`: the bar, or — while lanes
// draw it `elsewhere` — the handoff line, which says where, with the bar's
// indicator after it. [LAW:one-source-of-truth] The indicator reads the draw's
// one list, and its click opens the one viewer: while it is open the statusline
// shows it, the same body the lanes draw. [LAW:single-enforcer] It says what
// the frame it returns drew as not answered yet, so the frame and what it owes
// are decided together: the handoff line stands in for the bar and draws none
// of the bar's.
function statuslineOf(
  { sessionId, state, view }: RenderSetup,
  picks: SessionStateRW,
  drawn: DrawnBar,
  elsewhere: readonly Lane[],
): { readonly frame: Frame; readonly waited: readonly PendingRead[] } {
  const first = elsewhere[0];
  if (first === undefined || drawn.viewerOpen)
    return { frame: drawn.body, waited: drawn.waited };

  const effective = view.source.effective();
  const defaultsAfterReset = state.remainingLanes.get(effective.preset);
  if (defaultsAfterReset === undefined)
    throw new Error(
      `No lane reset defaults for resolved preset '${effective.preset}'`,
    );
  const editGlobals = editGlobalsOf(state.config, (key) =>
    picks.get(sessionId, key),
  );
  const remaining = perLane(
    (lane) =>
      editGlobals[LANES[lane].switch.setting] ?? defaultsAfterReset[lane],
  );
  return {
    frame: standIn(
      drawn.body,
      handoffRows(
        laneHandoff(
          sessionId,
          writableRoles(view.configAccess()),
          [first, ...elsewhere.slice(1)],
          remaining,
        ),
        drawn.diagnostics,
        sessionId,
        drawn.geometry,
      ),
    ),
    waited: [],
  };
}
