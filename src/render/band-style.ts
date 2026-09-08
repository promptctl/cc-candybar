// [LAW:one-way-deps] Lifts a decor colour into the Style a cell wears; imports
// flow themes → here → the walk and the picker.

import { ColorSpec, Style } from "@promptctl/rich-js";
import type { ColorRgba, Palette } from "@promptctl/rich-js";
import { bandItemFor, textOn, type AddressStep } from "../themes/decor.js";
import type { ActiveSegment } from "./active-segment.js";

// [LAW:one-source-of-truth] Text on a state cell is chosen against the
// background, never inherited from the segment's `fg:`.
export function stateCell(palette: Palette, background: ColorRgba): Style {
  return new Style({
    bgcolor: ColorSpec.fromRgba(background),
    color: ColorSpec.fromRgba(textOn(palette, background)),
  });
}

// The step arrives already placed by the band instance's own distribution.
export function bandItemStyle(active: ActiveSegment, step: AddressStep): Style {
  return stateCell(
    active.palette,
    bandItemFor(active.palette, active.disclosure, [step]),
  );
}
