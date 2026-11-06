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
// [LAW:single-enforcer] A feed encodes each lane once a frame, through the one
// encoder it made for the lane (src/daemon/frame-feed.ts), and hands every
// subscriber of the lane that encoding: the tmux status line's ids are minted
// once, and `frames --lane tmuxStatus` shows the ids tmux was given.

import type { BandOff } from "../../mod/types";
import { bandFrame } from "../band/frames";
import type { Frame } from "../render/frame";
import { tmuxStatusFrame, type TmuxStatusBar } from "../tmux-status/frames";
import { LinkIds, type LinkIdSource } from "../tmux-status/link-ids";
import type { Lane } from "../config/lanes";
import type { Response } from "./protocol";

// What a lane's subscriber in the daemon reads beside the JSON a client is
// sent: only the tmux status line has one.
export interface LaneValues {
  readonly band: null;
  readonly statusline: null;
  readonly pane: null;
  readonly tmuxStatus: TmuxStatusBar;
}

// One frame as its lane's subscribers receive it.
export interface LaneOut<L extends Lane> {
  readonly json: string;
  readonly value: LaneValues[L];
}

// A lane's encoder over a frame's bar and the answer the feed serialized for
// the lane. An instance holds what the lane keeps for the session: the tmux
// status line's link ids.
export type LaneEncoder<L extends Lane> = (
  bar: Frame,
  json: string,
) => LaneOut<L>;

// For each lane, a new encoder: a feed makes one when the lane's first
// subscriber joins and drops it when the last leaves.
export type LaneEncoders = { readonly [L in Lane]: () => LaneEncoder<L> };

export function laneEncoders(ids: LinkIdSource): LaneEncoders {
  return {
    band: () => (bar) => ({
      json: JSON.stringify(bandFrame(bar)),
      value: null,
    }),
    statusline: () => (_bar, json) => ({ json, value: null }),
    pane: () => (_bar, json) => ({ json, value: null }),
    tmuxStatus: () => {
      const table = new LinkIds(ids);
      return (bar) => {
        const value = tmuxStatusFrame(bar, table);
        return { json: JSON.stringify({ ok: true, tmuxStatus: value }), value };
      };
    },
  };
}

// [LAW:types-are-the-program] The band's lane-off line is the daemon's own
// SWITCHED_OFF refusal, relayed as it was sent: a refusal arm `BandOff` does
// not admit fails to compile here.
type SwitchedOff = Extract<Response, { ok: false }> & {
  readonly code: "SWITCHED_OFF";
};
true satisfies SwitchedOff extends BandOff ? true : never;
