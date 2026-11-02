// The closing sweep of candybar-joiners-e5r4 (test/helpers/seam-sweep.ts)
// under every variation, shipped and trial: in every bundled frame, under every bundled theme
// at truecolor, 256 colours and ansi, no seam joins two grounds drawn as one
// colour. `alt` turns each row's hue every three cells, and a trial tuning puts
// its keystone in the accent on a line of the secondary, so a line turns hue
// either side of it (candybar-joiners-e5r4.5x1). Walking the whole frame under
// every variation is the minutes this directory is for.

import { VARIATION_NAMES } from "../test/helpers/decor-vocabulary";
import { expectEverySeamHeld, sweepRigs, type SweepRigs } from "../test/helpers/seam-sweep";

let rigs: SweepRigs;
beforeAll(() => {
  rigs = sweepRigs();
});
afterAll(() => rigs.dispose());

test.each(VARIATION_NAMES)("under %s, no seam on any bundled frame joins two grounds drawn as one colour, under every theme at truecolor, 256 colours and ansi", (variation) => {
  expectEverySeamHeld(rigs, variation);
});
