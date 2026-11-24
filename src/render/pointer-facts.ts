// What a draw reads of the pointer: the gestures its surface delivers, and the
// action the pointer is on. Two draw projections (DRAW_PROJECTIONS in
// src/config/payload-inputs.ts), never stored: a pane's pointer ends with its
// subscription, so nothing here outlives the pane that reported it.

import { PLAIN_CLICK } from "../click/gesture.js";
import { modeInForce, NO_HOVER } from "../config/click-mode.js";
import type { PanePointer } from "../renderer-interface/interface.js";

// [LAW:one-source-of-truth] The gestures a draw's surface delivers, as the
// space-joined canonical names a template tests with
// `has "alt+left" (splitList " " .surface)`. A surface with no pane that owns
// a pointer is a link's: the plain click and nothing else.
export const surfaceOf = (pointer: PanePointer | null): string =>
  pointer === null ? PLAIN_CLICK : pointer.gestures.join(" ");

// What the session holds of the click mode (src/config/click-mode.ts): the
// mode, and the action a click last made hovered. Null for a key never
// written.
export interface HeldPointer {
  readonly mode: string | null;
  readonly hover: string | null;
}

// The action under the pointer, or "" for none: a template compares it as it
// does any string, and no action is named "". Where the surface sees the
// pointer move, that is the pane's report; where it does not and the session
// is in hover mode, it is the region a click last made hovered, and a change of
// mode puts it away.
export function hoverOf(
  pointer: PanePointer | null,
  held: HeldPointer,
): string {
  if (modeInForce(held.mode ?? undefined, surfaceOf(pointer)) !== "hover")
    return pointer?.hover ?? "";
  return held.hover === null || held.hover === NO_HOVER ? "" : held.hover;
}

export const pointerFacts = (
  pointer: PanePointer | null,
  held: HeldPointer,
): { readonly surface: string; readonly hover: string } => ({
  surface: surfaceOf(pointer),
  hover: hoverOf(pointer, held),
});
