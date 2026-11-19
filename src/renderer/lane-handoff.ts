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
import { presetGlobalsKey } from "../config/loader/persist-target.js";
import { presetByName, presetNames } from "../config/presets.js";
import {
  LANES,
  LANE_NAMES,
  perLane,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import { configWriteEffect, VERB_RESET_CONFIG } from "../click/wire.js";
import { actionTarget } from "../render/drawn-link.js";
import { resetLayers } from "./setting-drafts.js";
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

// [LAW:one-source-of-truth] Compute what survives the same reset keys the
// writer clears. The project layer never takes part in the handoff reset.
export function laneDefaultsAfterReset(
  config: DslConfig,
  bundled: DslConfig,
  project: RawDslConfig,
): ReadonlyMap<string, LaneSwitches> {
  const resetKeys = perLane(
    (lane) => new Set(resetLayers(LANES[lane].switch.setting).fileKeys),
  );
  return new Map(
    presetNames(config.presets).map((name) => {
      const preset = presetByName(config.presets, name);
      return [
        name,
        perLane((lane) => {
          const { setting } = LANES[lane].switch;
          const pin = resetKeys[lane].has(presetGlobalsKey(name, setting))
            ? (project.presets?.[name]?.globals?.[setting] ??
              bundled.presets[name]?.globals?.[setting])
            : preset.globals?.[setting];
          return (
            (pin ?? project.globals?.[setting] ?? bundled.globals[setting]) ===
            true
          );
        }),
      ];
    }),
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
            personal.map((role) =>
              configWriteEffect(
                VERB_RESET_CONFIG,
                sessionId,
                role,
                ...lanes.map((lane) => LANES[lane].switch.setting),
              ),
            ),
          ),
        )
      : diagnosticSpan(reason, null);
  return {
    severity: HANDOFF_SEVERITY,
    lines: [[line]],
  };
}
