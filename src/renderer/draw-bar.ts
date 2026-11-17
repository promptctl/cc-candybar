// One render of a session, a request's or a frame's, and what it records.

import type { MenusDrawn } from "./menu-idle.js";
import { inTmux } from "../tmux-hint.js";
import type { FileEventsWarning } from "../daemon/foundations/file-events-warnings";
import { launcherWarningsAt, type LauncherWarning } from "../proc/launcher";
import {
  DAEMON_EVENT_HOLD_S,
  eventHoldAt,
  type HeldEvent,
} from "../utils/event-hold.js";
import { updateNotice } from "../daemon/foundations/update-offer.js";
import { type CheckedRenderRequest } from "../renderer-interface/request-context.js";
import { UPDATE_DISMISSED_KEY } from "../daemon/foundations/update-keys";
import { type RenderOrigin } from "../config-hint";
import {
  refusedHints,
  refusedArgsError,
  refusedHintsError,
} from "../daemon/foundations/protocol";
import { type SessionId } from "../daemon/foundations/session-id";
import type { LayerRole } from "../config/layer-role";
import { repoQuestions } from "../config/repo-configs";
import {
  type CacheEntry,
  type RenderCache,
  type DslRenderState,
  type SessionHold,
  type SessionView,
} from "./render-cache";
import { watchFault } from "../daemon/foundations/watch-targets";
import { encodeRenderOrigin } from "../daemon/foundations/render-origin";
import {
  SESSION_CLIENT_HINTS_KEY,
  SESSION_RENDER_ORIGIN_KEY,
} from "../daemon/foundations/session-keys";
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
import type { WorldState } from "../facts/world-state.js";
import type { WorldStates } from "./world-states.js";
import { isPending } from "../utils/outcome.js";
import {
  laneSwitches,
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "../config/effective-globals.js";
import { type PassageFrame, type EffectSessions } from "../render/effect.js";
import {
  feedsFact,
  LANE_NAMES,
  LANES,
  ANSWERING,
  type Drawing,
  type Lane,
  type LaneFeeds,
  type LaneSwitches,
} from "../config/lanes.js";
import {
  type AdapterToHost,
  type FeedFrame,
} from "../renderer-interface/adapter.js";
import type { LaneActs } from "./lane-acts.js";
import type { Effect } from "../renderer-interface/interface.js";
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
import { type Instant } from "../utils/instant.js";
import {
  noteFacts,
  outcomeEvent,
  type RequestFacts,
} from "../daemon/foundations/request-event.js";

import type { SessionState } from "./session-state";
import type { RenderWarningRecords } from "./render-warnings.js";
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
  readonly sessionState: SessionState;
  readonly renderCache: RenderCache<SessionSource, CheckedRenderRequest>;
  readonly worldStates: WorldStates;
  readonly renderWarnings: RenderWarningRecords;
  readonly effectSessions: EffectSessions<RenderedLine>;
  // [LAW:single-enforcer] The signer every link this renderer draws is
  // signed with, over the state directory's key.
  readonly linkSigner: LinkSigner;
  // [LAW:single-enforcer] What turning a lane on or off asks of the host
  // (src/renderer/lane-acts.ts).
  readonly laneActs: Pick<LaneActs, "noted" | "clicked">;
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
// request writes, for the feed to log when that failure is first pushed; the
// feed summarizes the frames that render.
// [LAW:effects-at-boundaries] Synchronous by type: a frame reads every value
// as its owner stored it (the view's payload), so it performs no I/O and
// refreshes no source — the collector's triggers made those refreshes,
// and an event, never a frame, opened the view it draws.
export function renderFrame(
  parts: RendererParts,
  sessionId: SessionId,
  fps: number,
  at: Instant,
  // What the feed knows of its own lanes as it asks for the frame: which
  // follow the session and draw it now, and what each was sent of late; and
  // the session's idle period, as the renderer's menu idle holds it.
  feed: DrawnFor,
): { readonly frame: FeedFrame; readonly menus: MenusDrawn | null } | null {
  const facts: RequestFacts = [];
  try {
    using setup = setUpFrame(parts, sessionId, at, facts);
    if (setup === null) return null;
    const { drawn, evaluated, cellBreaks, delivered, lanes, menus } =
      drawRender(parts, setup, { by: "feed", fps }, feed.feeds, feed.idleSince);
    // [LAW:single-enforcer] Signed as they leave the renderer, the bar and
    // what the statusline shows alike, each link once.
    const signed = signingFrames(parts.linkSigner);
    const bar = signed(drawn.body);
    const answer = RENDER_ANSWERS.ansi(bar);
    const statusline = statuslineOf(
      sessionId,
      setup.state.writable,
      drawn,
      handedOffTo(lanes, feed.following),
    );
    // [LAW:one-source-of-truth] What the frame's copy clicks copy, recorded
    // as it is handed to the feed: a frame whose bytes match the last shows
    // the same links, and one whose lanes are all off ends its feed, whose
    // unpin retires what the feed drew.
    delivered();
    return {
      frame: {
        bar,
        resp: answer,
        // Mostly the bar itself, and one frame encodes once.
        statusline:
          statusline === drawn.body
            ? answer
            : RENDER_ANSWERS.ansi(signed(statusline)),
        evaluated,
        cellBreaks,
        lanes,
        failure: null,
      },
      menus,
    };
  } catch (error) {
    const outcome = renderFailure(failureOf(error));
    const { level, line } = outcomeEvent("render", facts, outcome);
    const failed = failedWith(outcome.message);
    return {
      frame: {
        bar: renderFailedFrame(failed.error),
        resp: failed,
        statusline: failed,
        evaluated: 0,
        cellBreaks: 0,
        lanes: viewLanes(parts, sessionId),
        failure: { level, line: `frame ${line}` },
      },
      // [LAW:no-silent-failure] A draw that threw drew no menu it can say.
      menus: null,
    };
  }
}

// Who a draw is drawn for, as the renderer's own state holds it: the lanes
// following the session and drawing it now, what each was sent of late, and
// when its menus' idle period began.
export interface DrawnFor {
  readonly following: ReadonlySet<Lane>;
  readonly feeds: LaneFeeds;
  readonly idleSince: Instant | null;
}

// [LAW:one-source-of-truth] A session's globals over the render state it
// draws with: the one resolution a render draws by and the lane gate reads.
// `.preset.customized` reads THIS state's authoredRoots — the set computed
// from the SAME raw parse that produced state.config, on the same reload —
// never a fresh file read that could race a concurrent write and disagree with
// the tree that actually rendered.
function sessionGlobals(
  parts: RendererParts,
  sessionId: SessionId,
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
  parts: RendererParts,
  sessionId: SessionId,
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
// reported — the same request a click's setups follow (src/renderer/
// lane-acts.ts). A session this daemon has no request from has no pane fact
// yet, so its switches are its settings alone: what the click moves is owed
// to its first request, which settles it against the pane that request
// reports, so a session outside tmux is owed nothing it can run.
export function lanesAt(
  parts: RendererParts,
  origin: RenderOrigin,
  sessionId: SessionId,
  latest: CheckedRenderRequest | null,
): LaneSwitches {
  const { renderCache } = parts;
  using hold = renderCache.hold(
    origin.projectDir,
    origin.cwd,
    origin.target.path,
  );
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

// [LAW:single-enforcer] A `config` turn: the facts of the context it carries
// noted, what the context says recorded, its world state taken, and the
// session's view opened at it and let go, so the turn's output names what the
// view reads before the request after it waits. The record goes first, so a
// durable click on a session whose opening threw still resolves the chain
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
  at: Instant,
  facts: RequestFacts,
): void {
  contextFacts(req, facts);
  noteFacts(facts, { encoding: req.encoding });
  runInAction(() => {
    recordRequest(parts, req);
    parts.worldStates.take(worldState);
    holdSessionAt(parts, req)[Symbol.dispose]();
  });
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
// opened, or kept and refreshed, at the config inputs the context names. A
// `config` turn opens it ahead of the request, and the request holds it again
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
  const { projectDir, cwd, target } = req.requested;
  return parts.renderCache.holdSession(projectDir, cwd, target.path, req);
}

export function setUpRender(
  parts: RendererParts,
  req: CheckedRenderRequest,
  at: Instant,
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
  // its `config`.
  const hintsError = hintsErrorOf(req);
  const hold = holdSessionAt(parts, req);
  return setUpDraw(parts, hold, req, hintsError, at, facts);
}

// [LAW:effects-at-boundaries] A frame's setup: the session's view as it finds
// it, drawn by the request the view is declared with, or null while the
// session has no view. It opens nothing (`holdView`).
function setUpFrame(
  parts: RendererParts,
  sessionId: SessionId,
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
    contextFacts(req, facts);
    hintsError = hintsErrorOf(req);
  } catch (e) {
    hold[Symbol.dispose]();
    throw e;
  }
  return setUpDraw(parts, hold, req, hintsError, at, facts);
}

// The setup over a held view, which owns the hold from here: a throw before
// it is returned releases it.
function setUpDraw(
  parts: RendererParts,
  hold: SessionHold<SessionSource, CheckedRenderRequest>,
  req: CheckedRenderRequest,
  hintsError: string | null,
  at: Instant,
  facts: RequestFacts,
): RenderSetup {
  // [LAW:one-source-of-truth] The instant the bar is drawn at, noted by the
  // draw: every time read in it reads this one.
  noteFacts(facts, { at: at.toFixed(3) });
  try {
    const { entry, state, view } = hold;
    // [LAW:dataflow-not-control-flow] One composition every render: the
    // entry always holds a renderable state (the bundled default until a
    // config loads — src/renderer/render-cache.ts), so body = drawDsl(state)
    // and output = diagnostics + body, with no "did the config load" branch.
    return {
      req,
      at,
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
  // When the idle period of the menus the session's last frame drew began,
  // as the renderer's menu idle held it for this draw.
  idleSince: Instant | null,
): {
  drawn: DrawnBar;
  evaluated: number;
  cellBreaks: number;
  clickShown: ClickErrorRecord | null;
  // The held events this draw showed (the launcher's pipe event, the last
  // renderer's end), which an answer carrying them marks answered.
  eventsShown: readonly HeldEvent[];
  // Records what the frame's copy clicks copy, once it reached its client.
  delivered: () => void;
  // Which animation lanes the session's settings switch on, as drawn.
  lanes: LaneSwitches;
  // What the draw drew of the session's menus, which their idle close
  // follows.
  menus: MenusDrawn;
} {
  const {
    sessionState,
    renderCache,
    linkSigner,
    renderWarnings,
    effectSessions,
  } = parts;
  const { req, at, facts, sessionId, entry, state, view, hintsError } = setup;
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
  const lanes = laneSwitches(effective, payload.tmux !== undefined);
  noteFacts(facts, {
    lanes: LANE_NAMES.filter((lane) => lanes[lane]).join(",") || "-",
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
  // [LAW:one-source-of-truth] The daemon-wide update notice, as the world
  // state carries it, read for THIS session: what it dismissed and whether
  // its config allows the notice — both values, folded by the notice into
  // zero or one offer and zero or one failure.
  const { update } = document.daemon;
  const updates = updateNotice(
    update.newer.kind === "ok" ? update.newer.value : null,
    update.act,
    {
      sessionId,
      dismissed: sessionState.get(sessionId, UPDATE_DISMISSED_KEY),
      enabled: effective.updateNotice,
    },
  );
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
    sourced("update-act", update.actsError),
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
    ...(entry.lastWarning === null
      ? []
      : [{ kind: "load" as const, message: entry.lastWarning }]),
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
    [...updates.offer, ...questions],
    [
      // [LAW:no-silent-failure] A failed update act is a warning of its own.
      ...updates.failure,
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
  // [LAW:no-silent-failure] What drawDsl had to settle for itself and could
  // not honour (`RenderWarning`): this frame's own, recorded for its renderer
  // after the walk, so the bar still renders and the indicator counts them.
  const drawnWarnings: RenderWarning[] = [];
  // [LAW:one-source-of-truth] The options drawDsl draws with are the SAME
  // `effective` struct the payload was just built from, projected by the one
  // `renderOptionsOf` every renderer shares — no second `?? DEFAULT_X`
  // computation to drift from it.
  const renderOpts = renderOptionsOf(effective, width);
  const effects = effectSessions.of(sessionId);
  // [LAW:single-enforcer] The view's inputs read its source (`bindView`, at
  // its opening): the draw hands only its own instant's facts.
  const { frame, evaluated, cellBreaks, rules } = drawDsl(
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
    { ...effective, effects, idleSince: idleSince ?? undefined },
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
  // What this frame drew is what the session's idle close follows.
  const menus: MenusDrawn = {
    shown: frame.rows.some((row) => row.kind === "menu"),
    timeoutS: effective.menuTimeout,
  };
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
  // A failed update act is a warning of its own, so it is tagged here too.
  const warned =
    [
      ...updates.failure.map(() => "update-failed"),
      ...[...standing, ...drawnWarnings].map(tagOf),
    ].join(",") || "-";
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
    upd: String(updates.offer.length),
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
    delivered,
    lanes,
    menus,
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

// [LAW:effects-at-boundaries] What a render request said, recorded where its
// context arrives, its session's `config` turn — never by a frame, which only
// draws, and which would wake its own feed by writing the session's state.
// Compared before writing: every set() persists and fires the session's MobX
// atom, so an unconditional per-request write would invalidate every
// state-driven computed each render.
function recordRequest(parts: RendererParts, req: CheckedRenderRequest): void {
  const { sessionState } = parts;
  const sessionId = req.hookData.session_id;
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
  // durable click on this session resolves the same chain (verbs/index.ts
  // sessionOrigin) and writes the file the next reload reads — never a path
  // re-derived from the daemon's own cwd.
  const origin = encodeRenderOrigin(req.requested);
  if (sessionState.get(sessionId, SESSION_RENDER_ORIGIN_KEY) !== origin) {
    sessionState.set(sessionId, SESSION_RENDER_ORIGIN_KEY, origin);
  }
}

// A render request's answer: the bar drawn for its client.
export interface RequestAnswer {
  // What this request's client is shown: the statusline's frame to Claude
  // Code's statusline, the bar to a client drawing it itself.
  readonly frame: Frame;
  // What to record once that frame reached its client: the copies its copy
  // clicks copy, and the click error and the launcher's pipe event it showed.
  readonly delivered: () => void;
  // What the draw drew of the session's menus.
  readonly menus: MenusDrawn;
}

export function answerRequest(
  parts: RendererParts,
  req: CheckedRenderRequest,
  at: Instant,
  // What the renderer's feeds and menu idle hold of the session as the
  // request's turn came.
  feed: DrawnFor,
  facts: RequestFacts,
  // The request's turn's effects, which the setups its session's clicks owe
  // join.
  effects: Effect[],
): RequestAnswer {
  using setup = setUpRender(parts, req, at, facts);
  // [LAW:effects-at-boundaries] What the request's arrival starts beyond its
  // own answer: the setups its session's clicks owe, by the lanes its
  // settings switch on as it arrived. No draw starts one.
  parts.laneActs.noted(
    req,
    laneSwitches(setup.view.source.effective(), inTmux(req.hints.tmux)),
    effects,
  );
  const sessionId = req.hookData.session_id;
  const { drawn, clickShown, eventsShown, delivered, lanes, menus } =
    drawRender(parts, setup, ANSWERING, feed.feeds, feed.idleSince);
  const elsewhere = handedOffTo(lanes, feed.following);
  // A `frames` display draws the bar itself; Claude Code's statusline hands
  // it to the lanes drawing it elsewhere.
  const toStatusline = roleOf(req.hints.client ?? null) === "statusline";
  // [LAW:single-enforcer] Signed as it leaves the renderer, each link once.
  const frame = signingFrames(parts.linkSigner)(
    toStatusline
      ? statuslineOf(sessionId, setup.state.writable, drawn, elsewhere)
      : drawn.body,
  );
  // [LAW:nothing-unseen] Which lanes the statusline handed the bar to. How
  // long the turn took to make the frame is the host's, which times it.
  noteFacts(facts, {
    handoff: (toStatusline ? elsewhere : []).join(",") || "-",
  });
  return {
    menus,
    frame,
    delivered: answerDelivered(
      parts,
      sessionId,
      delivered,
      clickShown,
      eventsShown,
    ),
  };
}

// What an answer records once it reached its client. Built here, apart from
// the draw, because a closure keeps alive every variable its function's other
// closures capture: one made inside the draw would hold the draw's setup until
// its frame settles.
// [LAW:single-enforcer] An answer carrying the click error or a daemon-wide
// held event that reaches its client is the one that delivered it
// (src/utils/event-hold.ts).
function answerDelivered(
  parts: RendererParts,
  sessionId: SessionId,
  copied: () => void,
  clickShown: ClickErrorRecord | null,
  eventsShown: readonly HeldEvent[],
): () => void {
  return () => {
    copied();
    if (clickShown !== null)
      answeredClickError(parts.sessionState, sessionId, clickShown);
    // Daemon-wide: one session's answer having shown the event is what makes
    // it not silent.
    for (const event of eventsShown) parts.eventAnswered(event);
  };
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
