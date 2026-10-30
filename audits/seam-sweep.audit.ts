// The closing sweep of candybar-joiners-e5r4 (test/helpers/seam-sweep.ts)
// under every trial tuning: in every bundled frame, under every bundled theme
// at truecolor, 256 colours and ansi, no seam joins two grounds drawn as one
// colour. A tuning puts its keystone in the accent on a line of the
// secondary, so the line turns hue either side of it (candybar-joiners-e5r4.5x1).
// The suite sweeps the shipped variations and holds the turn rule over every
// variation at the level it lives; walking the whole frame under all twelve
// tunings is the minutes this directory is for.

import { TRIAL_VARIATION_NAMES } from "../src/themes/decor";
import { expectEverySeamHeld, sweepRigs, type SweepRigs } from "../test/helpers/seam-sweep";

let rigs: SweepRigs;
beforeAll(() => {
  rigs = sweepRigs();
});
afterAll(() => rigs.dispose());

test.each(TRIAL_VARIATION_NAMES)("under %s, no seam on any bundled frame joins two grounds drawn as one colour, under every theme at truecolor, 256 colours and ansi", (variation) => {
  expectEverySeamHeld(rigs, variation);
});
