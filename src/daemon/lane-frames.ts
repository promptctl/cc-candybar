// Each animation lane's frames, as its subscriber draws them (epic
// candybar-animation-wbxz.81o). The band mod (A) draws rows of styled runs,
// which the daemon encodes beside the renderer that drew the bar, so the mod's
// child is a relay; the statusline (B) and the tmux pane (C) draw the ANSI the
// render produced, so their frames go as the feed serialized them.
//
// [LAW:one-type-per-behavior] The lane already names what its subscriber
// draws, so the encoding is a value keyed by it, not a field of the subscribe.
// [LAW:one-source-of-truth] Keyed by Lane: a lane removed from LANES leaves
// its entry an excess property the compiler names.

import type { BandOff } from "../../mod/types";
import { bandResponse } from "../band/frames";
import type { Lane } from "../config/lanes";
import type { Response } from "./protocol";

// A frame's JSON as its lane's subscriber receives it: from the response, or
// the JSON the feed serialized once for every subscriber.
type LaneFrame = (resp: Response, json: string) => string;

export const LANE_FRAMES: Readonly<Record<Lane, LaneFrame>> = {
  band: (resp) => JSON.stringify(bandResponse(resp)),
  statusline: (_resp, json) => json,
  pane: (_resp, json) => json,
};

// [LAW:types-are-the-program] The band's lane-off line is the daemon's own
// SWITCHED_OFF refusal, relayed as it was sent: a refusal arm `BandOff` does
// not admit fails to compile here.
type SwitchedOff = Extract<Response, { ok: false }> & {
  readonly code: "SWITCHED_OFF";
};
true satisfies SwitchedOff extends BandOff ? true : never;
