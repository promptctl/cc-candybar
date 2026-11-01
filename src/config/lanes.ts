// The animation lanes (epic candybar-animation-wbxz): three programs that draw
// the bar faster than Claude Code reruns its statusline, each by subscribing to
// the daemon's pushed frames (src/daemon/frame-feed.ts) — A in the band above
// the prompt (a Claude Code mod), B in a patched Claude Code's own statusline,
// C outside Claude Code, in tmux: a pane beside the session, and the tmux
// status line. Each is switched by a setting of its own, so it can be switched
// off, or removed, alone.
//
// [LAW:one-type-per-behavior] One behavior, three instances: a lane is a
// subscriber, and what differs between them is a name and its switch — the
// setting that turns it on and the value that does. The experimental lanes are
// each a 🧪 toggle; the tmux status line is on while the bar's renderer is
// tmux.
// [LAW:one-source-of-truth] THE table. The globals fields, the menu's
// controls (SETTINGS), the payload's read-back and the daemon's gate all
// derive from these rows or are keyed by them, so deleting a lane's row makes
// the compiler name everything left behind.

// Where the bar is drawn: Claude Code's own status line, or the tmux status
// line of the pane the session runs in. A session outside tmux has no tmux
// status line, so it draws in Claude Code's whatever the setting says.
export const RENDERERS = ["claude", "tmux"] as const;
export type Renderer = (typeof RENDERERS)[number];

// [LAW:one-source-of-truth] The one spelling of "this session runs in a tmux
// pane", as a template expression over the client's tmux hint: a slash click
// has a pane to type into (every bundled slash control gates on it, so none
// shows a button whose every click the verb would refuse), and the session
// has a tmux status line to draw in. A user's own slash button gates the same
// way: `when: '{{ ne .tmux.pane "" }}'`.
export const IN_TMUX = 'ne .tmux.pane ""';

// `handsOff` is whether a lane draws the bar somewhere other than the
// statusline: while it is on, the statusline hands off to it
// (src/daemon/lane-handoff.ts). Lane B draws the statusline itself, so it
// hands off nowhere. A switch that is `inTmux` is on only for a session its
// client reports in a tmux pane: the tmux status line belongs to that pane, so
// a session outside tmux ignores the setting, which other sessions share, and
// draws in Claude Code's statusline. `rows` is the most rows the lane's
// surface shows, or null when only the terminal bounds it.
export const LANES = {
  band: {
    switch: { setting: "experimentalBand", on: true, inTmux: false },
    label: "🧪 band (A)",
    handsOff: true,
    rows: null,
  },
  statusline: {
    switch: { setting: "experimentalStatusline", on: true, inTmux: false },
    label: "🧪 statusline (B)",
    handsOff: false,
    rows: null,
  },
  pane: {
    switch: { setting: "experimentalPane", on: true, inTmux: false },
    label: "🧪 tmux pane (C)",
    handsOff: true,
    rows: null,
  },
  tmuxStatus: {
    switch: {
      setting: "renderer",
      on: "tmux" satisfies Renderer,
      inTmux: true,
    },
    label: "tmux status line",
    handsOff: true,
    // tmux draws at most five status rows (`status` takes on, off, 2…5).
    rows: 5,
  },
} as const;

export type Lane = keyof typeof LANES;
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

// [LAW:one-source-of-truth] The most frames a second a lane is drawn at, while
// its pane is on a screen: the closest the daemon's feed spaces two frames,
// and the rate each lane's toggle turns its spinner at, so the spinner is
// smooth exactly when frames arrive as fast as the feed draws them.
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
