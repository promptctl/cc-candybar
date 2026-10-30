// While an animation lane draws a session's bar somewhere other than its
// statusline — the band above the prompt (A), a tmux pane (C) — the statusline
// shows one line instead of a second copy of the bar: where the bar is, and a
// button that resets those lanes' settings, in case the place they draw it
// has broken (Brandon: "we should NOT show the original bar except a single
// line that contains a button to reset those settings").
//
// [LAW:one-source-of-truth] Only the bytes Claude Code's statusline receives
// change: the lanes draw from the session's full render, which the feed is
// handed before this line replaces it (src/daemon/server.ts).

import {
  LANES,
  LANE_NAMES,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import { effectsUrl, VERB_COPY, VERB_RESET_CONFIG } from "../click/wire.js";
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
    (lane) =>
      lanes[lane] && LANES[lane].elsewhere !== null && following.has(lane),
  );
}

export const HANDOFF_BUTTON = "[⟲ draw it here]";

// The handoff line for `lanes` (non-empty): the sentence, which copies itself
// (it is in no diagnostic list, so no key names it, and it is one short
// sentence), then the button. The button resets each lane's
// setting at every layer (the settings menu's ↺ for it); what the lane runs
// follows the switch (src/daemon/lane-setup.ts), so a pane it opened closes.
export function laneHandoff(
  sessionId: string,
  lanes: readonly [Lane, ...Lane[]],
): ChannelMessage {
  const where = lanes.map((lane) => LANES[lane].elsewhere).join(" and ");
  const message = `the bar is drawn in ${where}`;
  const reset = effectsUrl([
    {
      verb: VERB_RESET_CONFIG,
      args: [sessionId, ...lanes.map((lane) => LANES[lane].setting)],
    },
  ]);
  return {
    severity: HANDOFF_SEVERITY,
    lines: [
      [
        diagnosticSpan(
          message,
          effectsUrl([{ verb: VERB_COPY, args: [message] }]),
        ),
        diagnosticSpan(HANDOFF_BUTTON, reset),
      ],
    ],
  };
}
