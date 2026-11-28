// The pushed displays. The ordinary statusline also draws on request.

import {
  SAYS_WHERE_POINTER_ACTS,
  type FeedEncoding,
} from "../render/encodings.js";

// [LAW:one-source-of-truth] The one spelling of "this session runs in a tmux
// pane", as a template expression over the client's tmux hint: a slash click
// has a pane to type into (every bundled slash control gates on it, so none
// shows a button whose every click the verb would refuse). A user's own slash button gates the same
// way: `when: '{{ ne .tmux.pane "" }}'`.
export const IN_TMUX = 'ne .tmux.pane ""';

// Each lane is a surface the bar is shown on, drawn its own frame. `encoding`
// is what its subscribers are pushed (src/render/encodings.ts).
// [LAW:one-source-of-truth] Settings, the feed and the protocol derive the
// available surfaces from this table.
export const LANES = {
  statusline: {
    switch: { setting: "experimentalStatusline", on: true },
    label: "🧪 statusline (B)",
    encoding: "ansi",
  },
  pane: {
    switch: { setting: "experimentalPane", on: true },
    label: "🧪 tmux pane (C)",
    encoding: "hit-mapped",
  },
  // The native window the bar floats in beside the session's terminal.
  window: {
    switch: { setting: "experimentalWindow", on: true },
    label: "🧪 window (D)",
    encoding: "frame",
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly switch: { readonly setting: string; readonly on: boolean };
      readonly label: string;
      readonly encoding: FeedEncoding;
    }
  >
>;

export const WINDOW_PLACEMENTS = ["docked", "inset"] as const;
export type WindowPlacement = (typeof WINDOW_PLACEMENTS)[number];
export const DEFAULT_WINDOW_PLACEMENT = "inset" satisfies WindowPlacement;
export type DeclaredLanes = LaneSwitches & {
  readonly windowPlacement?: WindowPlacement;
};

export type Lane = keyof typeof LANES;

// [LAW:one-source-of-truth] Whether a lane's follower may report the pointer
// over its surface: only one whose frames say where a pointer can act, since
// the hover it reports is the action it found there.
export const ownsPointer = (lane: Lane): boolean =>
  SAYS_WHERE_POINTER_ACTS[LANES[lane].encoding];
export type LaneSwitch = (typeof LANES)[Lane]["switch"];
// The settings that are a lane's own 🧪 toggle: a flag, on at `true`.
export type LaneSetting = Extract<LaneSwitch, { readonly on: true }>["setting"];
// The lanes a toggle of their own switches.
export type ToggledLane = {
  [L in Lane]: (typeof LANES)[L]["switch"]["on"] extends true ? L : never;
}[Lane];

export const LANE_NAMES = Object.keys(LANES) as readonly Lane[];
export const TOGGLED_LANES = LANE_NAMES.filter(
  (lane): lane is ToggledLane => LANES[lane].switch.on === true,
);

// Which lanes a session's settings switch on.
export type LaneSwitches = Readonly<Record<Lane, boolean>>;

// [LAW:one-source-of-truth] The animation rate for a visible surface. The feed and
// the spinner share this cadence. A click that changes the session view can
// publish an additional frame immediately.
export const MOVING_FPS = 30;

// [LAW:nothing-unseen] What one lane of a session's frames is doing, as the
// daemon's feed sees it: how many subscribers of that lane follow the session,
// the frames that went out to that lane in the last second (a
// subscriber's hand-over on joining is not one), and whether the session's pane
// is on a screen — a pane judged off screen is drawn at one frame a second.
// No subscriber is `subscribers: 0`, which pushes nothing.
export interface LaneFeed {
  readonly subscribers: number;
  readonly fps: number;
  readonly shown: boolean;
}
export type LaneFeeds = Readonly<Record<Lane, LaneFeed>>;

// [LAW:types-are-the-program] Who a render is drawn for: a client's render
// request, answered to that client alone, or the frame feed, whose frames are
// pushed to every lane's subscribers — with that feed's ceiling, the most
// frames a second it draws the bar at, which only a fed bar has. Set beside the payload as
// `drawing`, read through `drawing.by` and `drawing.fps`.
export type Drawing =
  | { readonly by: "request" }
  | { readonly by: "feed"; readonly fps: number };
export const ANSWERING: Drawing = { by: "request" };
export const DRAWING_VAR = "drawing";
export const drawingVar = (field: "by" | "fps"): `drawing.${typeof field}` =>
  `${DRAWING_VAR}.${field}`;

// A session no lane follows.
export const UNFOLLOWED: LaneFeed = { subscribers: 0, fps: 0, shown: true };

// The input variable a lane's feed fact reads back through.
export const laneFeedVar = <F extends keyof LaneFeed>(
  lane: Lane,
  field: F,
): `feeds.${Lane}.${F}` => `feeds.${lane}.${field}`;

// [LAW:types-are-the-program] A record total over LANES, one value per lane:
// the one place the totality `Object.fromEntries` cannot see is asserted.
export function perLane<T>(
  value: (lane: Lane) => T,
): Readonly<Record<Lane, T>> {
  return Object.fromEntries(
    LANE_NAMES.map((lane) => [lane, value(lane)]),
  ) as Record<Lane, T>;
}

// A session no lane follows, on every lane.
export const UNFOLLOWED_FEEDS: LaneFeeds = perLane(() => UNFOLLOWED);

// [LAW:parse-dont-validate] The one crossing from a wire string to a Lane.
export function parseLane(raw: unknown): Lane | null {
  return typeof raw === "string" && Object.hasOwn(LANES, raw)
    ? (raw as Lane)
    : null;
}

// The render event's `feeds=` field: each lane following the session as
// `<lane>:<subscribers>sub/<fps>fps/shown|offscreen`, `-` when none does.
export function feedsFact(feeds: LaneFeeds): string {
  return (
    LANE_NAMES.filter((lane) => feeds[lane].subscribers > 0)
      .map((lane) => {
        const { subscribers, fps, shown } = feeds[lane];
        return `${lane}:${subscribers}sub/${fps}fps/${shown ? "shown" : "offscreen"}`;
      })
      .join(",") || "-"
  );
}
