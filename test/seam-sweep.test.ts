// [LAW:verifiable-goals] candybar-joiners-e5r4: the closing sweep
// (test/helpers/seam-sweep.ts), held under every variation a user picks from
// the dial: in every bundled frame, under every bundled theme at truecolor,
// 256 colours and ansi, no seam joins two grounds drawn as one colour.
// candybar-joiners-e5r4.5x1: `alt` turns each row's hue every three cells, so
// two hues meet on one line, which the bundled variation never shows.
//
// The trial tunings put two hues on a line too, either side of a keystone.
// Swept here, their twelve sweeps would be several minutes of the two-core CI
// runner on their own, so the rule they turn on is held over every variation,
// the tunings among them, at the level it lives (test/decor.test.ts), and the
// whole bundled frame is swept under each of them nightly
// (audits/seam-sweep.audit.ts).

import { TRIAL_VARIATION_NAMES, type VariationName } from "../src/themes/decor";
import { VARIATION_NAMES } from "./helpers/decor-vocabulary";
import { expectEverySeamHeld, sweepRigs, type SweepRigs } from "./helpers/seam-sweep";

const SHIPPED: readonly VariationName[] = VARIATION_NAMES.filter((name) => !(TRIAL_VARIATION_NAMES as readonly string[]).includes(name));

let rigs: SweepRigs;
beforeAll(() => {
  rigs = sweepRigs();
});
afterAll(() => rigs.dispose());

test("the shipped variations are the dial's four", () => {
  expect([...SHIPPED].sort()).toEqual(["accent", "alt", "duo", "mono"]);
});

test.each(SHIPPED)("under %s, no seam on any bundled frame joins two grounds drawn as one colour, under every theme at truecolor, 256 colours and ansi", (variation) => {
  expectEverySeamHeld(rigs, variation);
});
