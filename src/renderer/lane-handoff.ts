// While the tmux pane draws the bar, Claude Code shows a handoff row: a button
// that draws the bar back in Claude Code's statusline, in case the place the
// lane draws it has broken, and the diagnostics indicator beside it, so an
// error is seen even where the lane's bar is not.
//
// [LAW:one-source-of-truth] Only the bytes Claude Code's statusline receives
// change: the lanes draw from the session's full render, which the feed is
// handed before this line replaces it (src/renderer/draw-bar.ts).

import type { SessionId } from "../daemon/foundations/session-id.js";
import type { LayerRole } from "../config/layer-role.js";
import type { DslConfig, RawDslConfig } from "../config/dsl-types.js";
import {
  LANES,
  LANE_NAMES,
  perLane,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import { configWriteArgs, VERB_RESET_CONFIG } from "../click/wire.js";
import { actionTarget } from "../render/drawn-link.js";
import { isBundledPreset } from "./bundled-presets.js";
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

// [LAW:one-source-of-truth] Reset clears personal global settings and
// personal deltas over bundled presets. The project and custom preset
// pins survive. Compute the remaining defaults once per configuration.
export function laneDefaultsAfterReset(
  config: DslConfig,
  bundled: DslConfig,
  project: RawDslConfig,
): ReadonlyMap<string, LaneSwitches> {
  return new Map(
    Object.entries(config.presets).map(([name, preset]) => [
      name,
      perLane((lane) => {
        const { setting } = LANES[lane].switch;
        const pin = isBundledPreset(name)
          ? (project.presets?.[name]?.globals?.[setting] ??
            bundled.presets[name]?.globals?.[setting])
          : preset.globals?.[setting];
        return (
          (pin ?? project.globals?.[setting] ?? bundled.globals[setting]) ===
          true
        );
      }),
    ]),
  );
}

// The handoff resets writable personal settings when that returns the bar.
// The project file keeps its settings.
export function laneHandoff(
  sessionId: SessionId,
  writable: readonly LayerRole[],
  lanes: readonly [Lane, ...Lane[]],
  remaining: LaneSwitches,
): ChannelMessage {
  const personal = writable.filter((role) => role !== "project");
  const reason =
    personal.length === 0
      ? "No writable personal config layer for the pane"
      : lanes.some((lane) => remaining[lane])
        ? "The pane stays enabled by its config"
        : null;
  const line =
    reason === null
      ? diagnosticSpan(
          HANDOFF_BUTTON,
          actionTarget(
            personal.map((role) => ({
              verb: VERB_RESET_CONFIG,
              args: configWriteArgs(
                sessionId,
                role,
                ...lanes.map((lane) => LANES[lane].switch.setting),
              ),
            })),
          ),
        )
      : diagnosticSpan(reason, null);
  return {
    severity: HANDOFF_SEVERITY,
    lines: [[line]],
  };
}
