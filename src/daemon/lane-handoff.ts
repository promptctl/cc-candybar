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
import {
  effectsUrl,
  VERB_COPY,
  VERB_LANE,
  VERB_RESET_CONFIG,
} from "../click/wire.js";
import {
  diagnosticSpan,
  HANDOFF_SEVERITY,
  type Diagnostics,
} from "../render/diagnostic-strip.js";

// The lanes the session's switches turn on that draw the bar elsewhere.
export function lanesDrawingElsewhere(lanes: LaneSwitches): Lane[] {
  return LANE_NAMES.filter(
    (lane) => lanes[lane] && LANES[lane].elsewhere !== null,
  );
}

export const HANDOFF_BUTTON = "[⟲ draw it here]";

// The handoff line for `lanes` (non-empty): the sentence, which copies itself
// like every diagnostic line, then the button. The button resets each lane's
// setting at every layer (the settings menu's ↺ for it) and then brings what
// the lane runs in line, so a pane it opened closes.
export function laneHandoff(
  sessionId: string,
  lanes: readonly [Lane, ...Lane[]],
): Diagnostics {
  const where = lanes.map((lane) => LANES[lane].elsewhere).join(" and ");
  const message = `the bar is drawn in ${where}`;
  const reset = effectsUrl([
    {
      verb: VERB_RESET_CONFIG,
      args: [sessionId, ...lanes.map((lane) => LANES[lane].setting)],
    },
    ...lanes.map((lane) => ({ verb: VERB_LANE, args: [sessionId, lane] })),
  ]);
  return {
    channels: [
      {
        severity: HANDOFF_SEVERITY,
        message,
        lines: [
          [
            diagnosticSpan(
              message,
              effectsUrl([{ verb: VERB_COPY, args: [message] }]),
            ),
            diagnosticSpan(HANDOFF_BUTTON, reset),
          ],
        ],
      },
    ],
  };
}
