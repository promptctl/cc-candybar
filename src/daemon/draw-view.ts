// One draw of a session's view: the walk of its config at an instant, and the
// body a client is shown — the bar, or the diagnostics viewer in its place.
//
// [LAW:single-enforcer] The daemon's draw (src/daemon/draw-bar.ts) and the
// demo's (src/demo/play.ts) both draw here, so a replay draws what the live
// draw drew from what it was handed, the open viewer included. Nothing here
// reads the daemon's parts: what a draw is handed beyond its view arrives as
// values, the ones a recording carries.

import type { RendererAddress } from "./home.js";
import type { SessionView } from "./cache/render.js";
import { renderOptionsOf, todayOf } from "./render-payload.js";
import type { SessionSource } from "./session-source.js";
import { laneSwitches } from "../config/effective-globals.js";
import {
  LANE_NAMES,
  LANES,
  type Drawing,
  type LaneFeeds,
  type LaneSwitches,
} from "../config/lanes.js";
import {
  drawDsl,
  type DrawnFrame,
  type RenderObservers,
} from "../dsl/render.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import {
  diagnosticsProjection,
  viewedIndex,
  viewerRowCap,
  viewerRows,
  type DiagnosticGeometry,
  type DiagnosticList,
  type ViewerPosition,
} from "../render/diagnostics.js";
import type { SessionEffects } from "../render/effect.js";
import { standIn, type Frame } from "../render/frame.js";
import type { Instant } from "../utils/instant.js";

// What a draw is handed beside its view and its instant: who it draws for,
// what each lane's feed is doing, and the one diagnostics list its door's
// indicator and its viewer read.
export interface Handed {
  readonly drawing: Drawing;
  readonly feeds: LaneFeeds;
  readonly diagnostics: DiagnosticList;
}

// [LAW:one-source-of-truth] The lanes a view's settings switch on, as its
// turn draws them: the tmux pane is the turn's payload's.
export function drawnLanes(source: SessionSource): LaneSwitches {
  return laneSwitches(source.effective(), source.payload().tmux !== undefined);
}

export interface ViewDrawn extends DrawnFrame {
  // What the client is shown: the walk's frame, or the viewer standing in for
  // it while one is open on a message of the list.
  readonly body: Frame;
  readonly viewing: ViewerPosition | null;
  readonly geometry: DiagnosticGeometry;
}

// The view drawn at `at` from what it was `handed`, under the session's
// effect memory and the instant its menus' idle period began. `viewing` is the
// session's stored viewer position, open only while it names a message of the
// handed list. The walk's frame is returned beside the body, because what a
// menu's idle period observes is the bar, not the viewer over it.
export function drawView(
  view: SessionView<SessionSource>,
  handed: Handed,
  at: Instant,
  effects: SessionEffects<RenderedLine>,
  idleSince: Instant | undefined,
  viewing: string | null,
  to: RendererAddress,
  onRenderWarning: NonNullable<RenderObservers["onRenderWarning"]>,
): ViewDrawn {
  const { drawing, feeds, diagnostics } = handed;
  const { source } = view;
  const effective = source.effective();
  // [LAW:one-source-of-truth] The width is `renderWidth` of the turn's hints —
  // the client's cols, else the default, less Claude Code's reserve — which
  // its payload carries as `term.cols`.
  const width = source.payload().term.cols;
  const drawn = drawDsl(
    view.state.config,
    view.state.compiled,
    view.store,
    view.registry,
    {
      diagnostics: diagnosticsProjection(diagnostics),
      drawing,
      feeds,
      today: todayOf(source.facts().builtins.today, at),
    },
    at,
    // [LAW:one-source-of-truth] The options drawDsl draws with are the SAME
    // `effective` struct the payload was built from, projected by the one
    // `renderOptionsOf` every renderer shares.
    renderOptionsOf(effective, width),
    // [LAW:single-enforcer] The per-segment StripCell sink for the `debug
    // segments` projection. Its identity stays stable for the view's
    // lifetime; drawDsl clears + repopulates it in place.
    { perSegmentSink: view.lastRenderCellsBySegment, onRenderWarning },
    // [LAW:one-source-of-truth] The draw's own settings and the session's
    // effect memory. The theme, style and effect are not among them: the
    // view's slots settle those names (src/dsl/parts.ts), the same ones its
    // payload's `.effective` fields read.
    { ...effective, effects, idleSince },
  );
  const lanes = drawnLanes(source);
  const geometry: DiagnosticGeometry = {
    width,
    // A feed's one frame is shown by every lane switched on, so it pages
    // within the shortest of their surfaces.
    rows: viewerRowCap(
      source.hints().termRows,
      drawing.by === "feed"
        ? LANE_NAMES.flatMap((lane) => {
            const rows = LANES[lane].rows;
            return lanes[lane] && rows !== null ? [rows] : [];
          })
        : [],
    ),
    // [LAW:one-source-of-truth] What stands in the frame's place is drawn at
    // the depth the frame is encoded at.
    colorCompatibility: drawn.frame.depth,
  };
  // [LAW:dataflow-not-control-flow] The viewer, while open, takes the body's
  // place: open only while the message it was opened on is in this list.
  const position = viewedIndex(viewing, diagnostics);
  return {
    ...drawn,
    body:
      position === null
        ? drawn.frame
        : standIn(
            drawn.frame,
            viewerRows(
              diagnostics,
              position,
              to,
              view.sessionId,
              drawing.by,
              geometry,
            ),
          ),
    viewing: position,
    geometry,
  };
}
