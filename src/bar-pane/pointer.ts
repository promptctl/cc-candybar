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
import { LIST_PANES_FORMAT } from "../daemon/pane-visibility.js";

// [LAW:one-source-of-truth] The pane's `list-panes` line: the daemon's own
// format and tmux's `mouse` option after it, which the same call answers, so
// the option costs the tick no process of its own. A format reads an option
// as the value in effect for the pane, the session's own or the one it
// inherits, and spells it `1` or `0`.
export const BAR_PANE_FORMAT = `${LIST_PANES_FORMAT} #{mouse}`;
const MOUSE_FIELD = LIST_PANES_FORMAT.split(" ").length;

// The gestures tmux's own default bindings take before a pane sees them: its
// pane menu is on alt+right (`M-MouseDown3Pane`, checked against tmux 3.8's
// root key table). A terminal may keep a modifier click for its own selection
// too, which the pane cannot know.
const TAKEN_BY_TMUX: readonly GestureName[] = ["alt+right"];

// What tmux delivers to a pane follows its `mouse` option: on, every button
// and modifier it does not bind itself and the pointer's motion; off, tmux
// hands the pane nothing, and the terminal opens its links on the plain click
// as it does for the statusline.
export function deliveredIn(
  listPanes: string,
  own: string,
): readonly Delivered[] {
  const line = listPanes
    .split("\n")
    .map((row) => row.trim().split(" "))
    .find(([id]) => id === own);
  return line?.[MOUSE_FIELD] === "1"
    ? [...ALL_GESTURES.filter((g) => !TAKEN_BY_TMUX.includes(g)), HOVER]
    : [PLAIN_CLICK];
}
