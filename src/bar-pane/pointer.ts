// What the bar pane tells the host of its pointer (OwnerFacts): the gestures
// its terminal delivers, which hover is part of.
//
// [LAW:effects-at-boundaries] Pure: the pane reads tmux and sends the facts.

import {
  ALL_GESTURES,
  HOVER,
  PLAIN_CLICK,
  type Delivered,
  type GestureName,
} from "../click/gesture.js";
// The gestures tmux's own default bindings take before a pane sees them: its
// pane menu is on alt+right (`M-MouseDown3Pane`, checked against tmux 3.8's
// root key table). A terminal may keep a modifier click for its own selection
// too, which the pane cannot know.
const TAKEN_BY_TMUX: readonly GestureName[] = ["alt+right"];

// What tmux delivers to a pane follows its `mouse` option: on, every button
// and modifier it does not bind itself and the pointer's motion; off, tmux
// hands the pane nothing, and the terminal opens its links on the plain click
// as it does for the statusline.
export function deliveredWithMouse(mouse: boolean): readonly Delivered[] {
  return mouse
    ? [...ALL_GESTURES.filter((g) => !TAKEN_BY_TMUX.includes(g)), HOVER]
    : [PLAIN_CLICK];
}
