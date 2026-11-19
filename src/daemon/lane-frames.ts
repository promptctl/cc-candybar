// Each animation lane's frames, as its subscriber draws them (epic
// candybar-animation-wbxz.81o). The band mod (A) draws rows of styled runs,
// which the daemon encodes from the drawn Frame, so the mod's child is a relay;
// the statusline (B) and the tmux pane (C) draw the ANSI the render produced,
// so their frames go as the feed serialized them; the tmux status line (C)
// draws tmux formats (src/tmux-status/frames.ts).
//
// [LAW:one-type-per-behavior] The lane already names what its subscriber
// draws, so the encoding is a value keyed by it, not a field of the subscribe.
// [LAW:one-source-of-truth] Keyed by Lane: a lane removed from LANES leaves
// its entry an excess property the compiler names.

import type { BandOff } from "../../mod/types";
import { bandFrame } from "../band/frames";
import { renderFailedFrame, type Frame } from "../render/frame";
import { framed, type Framed } from "./foundations/render-answers";
import { tmuxStatusFrame } from "../tmux-status/frames";
import type { Lane } from "../config/lanes";
import type { Response } from "./foundations/protocol";

// A frame's JSON as its lane's subscriber receives it: from the bar, or the
// JSON the feed serialized once for every subscriber of the lane.
type LaneFrame = (bar: Frame, json: string) => string;

export const LANE_FRAMES: Readonly<Record<Lane, LaneFrame>> = {
  band: (bar) => JSON.stringify(bandFrame(bar)),
  statusline: (_bar, json) => json,
  pane: (_bar, json) => json,
  tmuxStatus: (bar) =>
    JSON.stringify({ ok: true, tmuxStatus: tmuxStatusFrame(bar) }),
};

// A pushed frame as its lane's subscriber receives it, framed. One its lane
// cannot send is the render failure naming why, as the renderer draws a
// render that failed (src/renderer/draw-bar.ts): the failure's bar, and its
// RENDER_FAILED answer, so each lane says it in its own shape.
export const laneFramed = (
  lane: Lane,
  bar: Frame,
  json: string,
): Framed<readonly [Frame, string]> =>
  framed(
    [bar, json] as const,
    ([drawn, answer]) => LANE_FRAMES[lane](drawn, answer),
    (failed) => [renderFailedFrame(failed.error), JSON.stringify(failed)],
  );

// [LAW:types-are-the-program] The band's lane-off line is the daemon's own
// SWITCHED_OFF refusal, relayed as it was sent: a refusal arm `BandOff` does
// not admit fails to compile here.
type SwitchedOff = Extract<Response, { ok: false }> & {
  readonly code: "SWITCHED_OFF";
};
true satisfies SwitchedOff extends BandOff ? true : never;
