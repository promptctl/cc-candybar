// The animation lanes (epic candybar-animation-wbxz): three programs that draw
// the bar faster than Claude Code reruns its statusline, each by subscribing to
// the daemon's pushed frames (src/daemon/frame-feed.ts) — A in the band above
// the prompt (a Claude Code mod), B in a patched Claude Code's own statusline,
// C in a tmux pane beside the session. All three are experimental, and each
// sits behind its own toggle so it can be switched off, or removed, alone.
//
// [LAW:one-type-per-behavior] One behavior, three instances: a lane is a
// subscriber, and what differs between them is a name and a setting.
// [LAW:one-source-of-truth] THE table. The globals fields, the menu's
// controls (SETTINGS), the payload's read-back and the daemon's gate all
// derive from these rows or are keyed by them, so deleting a lane's row makes
// the compiler name everything left behind.

import { settingMenuPath } from "./menu-places.js";

// `elsewhere` is where a lane draws the bar when that is not the statusline:
// while it is on, the statusline hands off to it (src/daemon/lane-handoff.ts).
// Lane B draws the statusline itself, so it hands off nowhere.
export const LANES = {
  band: {
    setting: "experimentalBand",
    label: "🧪 band (A)",
    elsewhere: "the band above the prompt",
  },
  statusline: {
    setting: "experimentalStatusline",
    label: "🧪 statusline (B)",
    elsewhere: null,
  },
  pane: {
    setting: "experimentalPane",
    label: "🧪 tmux pane (C)",
    elsewhere: "a tmux pane below",
  },
} as const;

export type Lane = keyof typeof LANES;
export type LaneSetting = (typeof LANES)[Lane]["setting"];

export const LANE_NAMES = Object.keys(LANES) as readonly Lane[];

// Which lanes a session's settings switch on.
export type LaneSwitches = Readonly<Record<Lane, boolean>>;

// Every lane is off until a config or a session turns it on.
export const LANE_FLOOR = false;

// [LAW:one-source-of-truth] The rate a lane's frames are drawn at while the bar
// moves where someone can see it: the daemon's feed is scheduled by it, and
// each lane's toggle turns its spinner at it, so the spinner is smooth exactly
// when frames arrive as fast as the feed draws them.
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

// The input variable a lane's toggle reads back through: the value the bar
// rendered with, whichever rung produced it.
export const laneEffectiveVar = (lane: Lane): `lanes.${Lane}.effective` =>
  `lanes.${lane}.effective`;

// Why a subscriber of `lane` is refused, naming the switch that admits it.
export const laneOffReason = (lane: Lane): string =>
  `${LANES[lane].label} is off — turn it on in the settings menu's ${settingMenuPath(LANES[lane].setting)}, or set globals.${LANES[lane].setting}: true`;
