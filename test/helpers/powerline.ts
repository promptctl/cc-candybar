import { JOINERS, type SeamCell } from "@promptctl/rich-js";

// The glyphs the powerline joiner draws at each kind of join, read off the
// shape rich-js renders with, so a test spells no glyph of its own: `glyph`
// between two cells, whatever their grounds, `lead` entering a run (the arrow
// in reverse video, a notch of the terminal's ground) and `tail` leaving one.
const one = (cells: readonly SeamCell[]): string => {
  const cell = cells[0];
  const glyph = cell !== undefined && "glyph" in cell ? cell.glyph : undefined;
  if (typeof glyph !== "string") throw new Error("powerline: expected one plain glyph");
  return glyph;
};
const { seam } = JOINERS.powerline.seam.glyph;
const { lead, tail } = JOINERS.powerline.caps.glyph;
export const POWERLINE = Object.freeze({
  glyph: one(seam),
  lead: one(lead),
  tail: one(tail),
});
