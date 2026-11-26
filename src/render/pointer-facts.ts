// What a draw reads of the pointer: the gestures its surface delivers, and the
// action the pointer is on. Two draw projections (DRAW_PROJECTIONS in
// src/config/payload-inputs.ts), never stored: an owner's pointer ends with
// its subscription, so nothing here outlives the follower that reported it.

import { PLAIN_CLICK, type Delivered, type Pointer } from "../click/gesture.js";
import { NO_HOVER, type ClickMode } from "../config/click-mode.js";

// [LAW:one-source-of-truth] The gestures a draw's surface delivers. A surface
// with no follower that owns a pointer is a link's: the plain click and
// nothing else.
export const surfaceOf = (pointer: Pointer | null): readonly Delivered[] =>
  pointer === null ? [PLAIN_CLICK] : pointer.gestures;

// The action under the pointer, or "" for none: a template compares it as it
// does any string, and no action is named "". Where the surface sees the
// pointer move, that is its owner's report; where it does not and the session
// is in hover mode, it is the region a click last made hovered (`held`, null
// for a key never written), and a change of mode puts it away.
export function hoverOf(
  pointer: Pointer | null,
  mode: ClickMode,
  held: string | null,
): string {
  if (mode !== "hover") return pointer?.hover ?? "";
  return held === null || held === NO_HOVER ? "" : held;
}

// What the payload carries of the pointer: the surface's gestures space-joined,
// as a template tests them with `has "alt+left" (splitList " " .surface)`.
export const pointerFacts = (
  pointer: Pointer | null,
  mode: ClickMode,
  held: string | null,
): { readonly surface: string; readonly hover: string } => ({
  surface: surfaceOf(pointer).join(" "),
  hover: hoverOf(pointer, mode, held),
});
