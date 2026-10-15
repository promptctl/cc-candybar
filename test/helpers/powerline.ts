import { JOINERS, type JoinCell } from "@promptctl/rich-js";

// The glyphs the powerline joiner draws at each kind of join, read off the
// shape rich-js renders with, so a test spells no glyph of its own: `glyph`
// between two grounds, `divider` where the two grounds look the same, `lead`
// entering a run (the arrow in reverse video, a notch of the terminal's
// ground) and `tail` leaving one.
const one = (cells: readonly JoinCell[]): string => {
  const glyph = cells[0]?.glyph;
  if (typeof glyph !== "string") throw new Error("powerline: expected one plain glyph");
  return glyph;
};
const { seam, divider, lead, tail } = JOINERS.powerline.shape;
export const POWERLINE = Object.freeze({
  glyph: one(seam),
  divider: one(divider),
  lead: one(lead),
  tail: one(tail),
});
