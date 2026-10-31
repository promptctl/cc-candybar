// While a lane draws a session's bar somewhere other than its statusline —
// the band above the prompt (A), a tmux pane or the tmux status line (C) — the
// statusline shows one small row instead of a second copy of the bar: a button
// that draws the bar back in Claude Code's statusline, in case the place the
// lane draws it has broken, and the error indicator beside it, so an error is
// seen even where the lane's bar is not.
//
// [LAW:one-source-of-truth] Only the bytes Claude Code's statusline receives
// change: the lanes draw from the session's full render, which the feed is
// handed before this line replaces it (src/daemon/draw-bar.ts).

import {
  LANES,
  LANE_NAMES,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import { effectsUrl, VERB_RESET_CONFIG } from "../click/wire.js";
import {
  diagnosticSpan,
  HANDOFF_SEVERITY,
  type ChannelMessage,
} from "../render/diagnostics.js";

// The lanes the statusline hands the bar to: switched on, drawing it
// elsewhere, and followed by a subscriber now — a switch alone draws nothing,
// and a lane whose setup failed or has yet to start leaves the bar here.
export function handedOffTo(
  lanes: LaneSwitches,
  following: ReadonlySet<Lane>,
): Lane[] {
  return LANE_NAMES.filter(
    (lane) => lanes[lane] && LANES[lane].handsOff && following.has(lane),
  );
}

export const HANDOFF_BUTTON = "[⟲ claude]";

// The handoff row for `lanes` (non-empty): the button alone; the error
// indicator is laid after it where the row is drawn (src/render/diagnostics.ts).
// The button resets each lane's switch at every layer (the settings menu's ↺
// for it), which puts the renderer back to `claude` and turns a 🧪 lane off;
// what the lane runs follows the switch (src/daemon/lane-setup.ts), so a pane
// it opened closes.
export function laneHandoff(
  sessionId: string,
  lanes: readonly [Lane, ...Lane[]],
): ChannelMessage {
  const reset = effectsUrl([
    {
      verb: VERB_RESET_CONFIG,
      args: [sessionId, ...lanes.map((lane) => LANES[lane].switch.setting)],
    },
  ]);
  return {
    severity: HANDOFF_SEVERITY,
    lines: [[diagnosticSpan(HANDOFF_BUTTON, reset)]],
  };
}
