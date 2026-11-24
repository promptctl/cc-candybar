// What a draw reads of the pointer: the gestures its surface delivers, and the
// action the pointer is on. Two draw projections (DRAW_PROJECTIONS in
// src/config/payload-inputs.ts), never stored: a pane's pointer ends with its
// subscription, so nothing here outlives the pane that reported it.

import { PLAIN_CLICK } from "../click/gesture.js";
import type { PanePointer } from "../renderer-interface/interface.js";

// [LAW:one-source-of-truth] The gestures a draw's surface delivers, as the
// space-joined canonical names a template tests with
// `has "alt+left" (splitList " " .surface)`. A surface with no pane that owns
// a pointer is a link's: the plain click and nothing else.
export const surfaceOf = (pointer: PanePointer | null): string =>
  pointer === null ? PLAIN_CLICK : pointer.gestures.join(" ");

// The action under the pointer, or "" for none: a template compares it as it
// does any string, and no action is named "".
export const hoverOf = (pointer: PanePointer | null): string =>
  pointer?.hover ?? "";

export const pointerFacts = (
  pointer: PanePointer | null,
): { readonly surface: string; readonly hover: string } => ({
  surface: surfaceOf(pointer),
  hover: hoverOf(pointer),
});
