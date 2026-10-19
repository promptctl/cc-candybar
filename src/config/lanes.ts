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

export const LANES = {
  band: { setting: "experimentalBand", label: "🧪 band (A)" },
  statusline: { setting: "experimentalStatusline", label: "🧪 statusline (B)" },
  pane: { setting: "experimentalPane", label: "🧪 tmux pane (C)" },
} as const;

export type Lane = keyof typeof LANES;
export type LaneSetting = (typeof LANES)[Lane]["setting"];

export const LANE_NAMES = Object.keys(LANES) as readonly Lane[];

// Which lanes a session's settings switch on.
export type LaneSwitches = Readonly<Record<Lane, boolean>>;

// Every lane is off until a config or a session turns it on.
export const LANE_FLOOR = false;

// [LAW:types-are-the-program] A record total over LANES, one value per lane:
// the one place the totality `Object.fromEntries` cannot see is asserted.
export function perLane<T>(
  value: (lane: Lane) => T,
): Readonly<Record<Lane, T>> {
  return Object.fromEntries(
    LANE_NAMES.map((lane) => [lane, value(lane)]),
  ) as Record<Lane, T>;
}

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
  `${LANES[lane].label} is off — turn it on in the settings menu's ⚙ config tab, or set globals.${LANES[lane].setting}: true`;
