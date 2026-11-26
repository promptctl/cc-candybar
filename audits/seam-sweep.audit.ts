// The closing sweep of candybar-joiners-e5r4 (test/helpers/seam-sweep.ts)
// under every look a user can pick: no seam joins two grounds drawn as one
// colour. `alt` turns each row's hue every three cells, and a trial tuning puts
// its keystone in the accent on a line of the secondary, so a line turns hue
// either side of it (candybar-joiners-e5r4.5x1). Two scopes, since what decides
// which two colours meet differs: every frame at every depth under each
// variation at the dial's and style's floors; and the closed bar, hot and calm,
// at each depth under each variation × dial position × style. Walking them is
// the minutes this directory is for.

import { floorOf } from "../src/config/globals-fields";
import { STYLE_FLOOR } from "../src/themes/policy";
import { SHADE_NAMES, VARIATION_NAMES } from "../test/helpers/decor-vocabulary";
import {
  CALM,
  CLOSED,
  DEPTH_NAMES,
  HOT,
  STYLE_NAMES,
  VIEWS,
  expectEverySeamHeld,
  sweepRigs,
  type SweepRigs,
} from "../test/helpers/seam-sweep";

let rigs: SweepRigs;
beforeAll(() => {
  rigs = sweepRigs();
});
afterAll(() => rigs.dispose());

test.each(VARIATION_NAMES)(
  "under %s, no seam on any bundled frame joins two grounds drawn as one colour, under every theme at truecolor, 256 colours and ansi",
  (variation) => {
    expectEverySeamHeld(rigs, {
      looks: [{ variation, shade: floorOf("shade"), style: STYLE_FLOOR }],
      depths: DEPTH_NAMES,
      views: VIEWS,
      payloads: [HOT],
    });
  },
);

test.each(VARIATION_NAMES)(
  "under %s, at every position of the shade dial and every style, no seam of the closed bar joins two grounds drawn as one colour, hot and calm, under every theme at all three depths",
  (variation) => {
    expectEverySeamHeld(rigs, {
      looks: SHADE_NAMES.flatMap((shade) =>
        STYLE_NAMES.map((style) => ({ variation, shade, style })),
      ),
      depths: DEPTH_NAMES,
      views: [CLOSED],
      payloads: [HOT, CALM],
    });
  },
);
