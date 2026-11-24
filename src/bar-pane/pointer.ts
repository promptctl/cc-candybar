// What the bar pane tells the host of its pointer (OwnerFacts): the gestures
// its terminal delivers, which hover is part of.
//
// [LAW:effects-at-boundaries] Pure: the pane reads tmux and sends the facts.

import {
  ALL_GESTURES,
  HOVER,
  PLAIN_CLICK,
  type Delivered,
} from "../click/gesture.js";

// [LAW:one-source-of-truth] What tmux delivers to a pane follows its `mouse`
// option: on, every button and modifier it reports and the pointer's motion;
// off, tmux hands the pane nothing, and the terminal opens its links on the
// plain click as it does for the statusline.
export function deliveredBy(mouseOption: string): readonly Delivered[] {
  return mouseOption.trim() === "on" ? [...ALL_GESTURES, HOVER] : [PLAIN_CLICK];
}
