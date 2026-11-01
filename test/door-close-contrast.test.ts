// [LAW:verifiable-goals] candybar-joiners-e5r4.i30: the settings door's open
// ✖ reads on the ground it is drawn on. It is red on every theme because it is
// always a red the theme names for its error role; it reads because it is one
// of those that clears TEXT_MIN_CONTRAST on its ground, and where none does,
// the one standing farthest off, on the grounds listed below. Driven through
// the real loader, `resolveEffectiveGlobals` and `renderDsl`, under every
// bundled theme, dial position and variation, at truecolor, 256 and ansi, each
// pair measured as the terminal draws it.

import { ColorDepth, contrastRatio, drawnColour, getThemePalette, listThemePalettes, type ColorRgba } from "@promptctl/rich-js";
import { floorOf } from "../src/config/globals-fields";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import {
  SHADES,
  TEXT_MIN_CONTRAST,
  VARIATIONS,
  lineageHue,
  pressedAt,
  shadeRole,
  type ShadeName,
  type ShadeRole,
  type VariationName,
} from "../src/themes/decor";
import { instantOf } from "../src/utils/instant";
import { ERROR_REDS, doorClose, type ErrorRed } from "./helpers/door-close";
import { sessionBar, type SessionBar } from "./helpers/session-bar";

const THEMES = listThemePalettes();
const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
const VARIATION_NAMES = Object.keys(VARIATIONS) as VariationName[];
const COLS = 200;
const AT = instantOf(new Date("2026-10-30T12:00:00Z"));

// The door's ground: the hue its variation opens menus in, at the rung its dial
// position presses the door into. A shade the palette names, so it names the
// listing below, and the sweep holds the drawn ground to it.
const groundOf = (variation: VariationName, shade: ShadeName): ShadeRole =>
  shadeRole(lineageHue(VARIATIONS[variation].open, 0), SHADES[shade].activated);

// Every dial position under the bundled variation, and every variation at the
// first dial position that presses into each rung a pressed door can wear: so
// every dial position and every variation is drawn, and every ground they give
// the door at truecolor. Every variation crossed with every dial position
// reaches no ground more there.
const BUNDLED = floorOf("variation");
const PRESSING = SHADE_NAMES.filter(
  (shade, i) => SHADE_NAMES.findIndex((first) => SHADES[first].activated === SHADES[shade].activated) === i,
);
const LOOKS: ReadonlyArray<readonly [VariationName, ShadeName]> = [
  ...SHADE_NAMES.map((shade) => [BUNDLED, shade] as const),
  ...VARIATION_NAMES.filter((variation) => variation !== BUNDLED).flatMap((variation) =>
    PRESSING.map((shade) => [variation, shade] as const),
  ),
];

// The themes on which no red they name clears the floor on one of the door's
// grounds, by that ground: the red the ✖ wears there, the one standing
// farthest off it, and the ratio it reaches at truecolor. Keyed by the
// bundled themes' own names, so every entry is one a theme's sweep holds.
const FARTHEST: Readonly<Partial<Record<(typeof THEMES)[number], Partial<Record<ShadeRole, readonly [ErrorRed, string]>>>>> = {
  "atom-one-dark": {
    "accent-lighten-2": ["error-darken-3", "3.31"],
    "primary-muted": ["error-lighten-3", "4.09"],
    "secondary-lighten-2": ["error-darken-3", "3.81"],
  },
  "atom-one-light": {
    "accent-lighten-2": ["error-darken-3", "4.31"],
    "primary-lighten-2": ["error-darken-3", "3.00"],
    "secondary-lighten-2": ["error-darken-3", "2.18"],
  },
  "catppuccin-frappe": {
    "accent-muted": ["error-lighten-3", "4.00"],
    "primary-lighten-2": ["error-darken-3", "4.03"],
    "secondary-lighten-2": ["error-darken-3", "3.91"],
    "secondary-muted": ["error-lighten-3", "4.49"],
  },
  "catppuccin-latte": {
    "accent-lighten-2": ["error-darken-3", "4.38"],
    "primary-lighten-2": ["error-darken-3", "2.95"],
  },
  "catppuccin-macchiato": {
    "primary-lighten-2": ["error-darken-3", "3.71"],
    "secondary-lighten-2": ["error-darken-3", "3.83"],
  },
  "catppuccin-mocha": {
    "accent-lighten-2": ["error-darken-3", "3.72"],
    "primary-lighten-2": ["error-darken-3", "4.32"],
    "secondary-lighten-2": ["error-darken-3", "3.53"],
  },
  cyberpunk: {
    "accent-muted": ["text-error", "2.68"],
    "primary-muted": ["text-error", "3.03"],
    "secondary-lighten-2": ["error-darken-3", "2.44"],
    "secondary-muted": ["text-error", "4.35"],
  },
  default: {
    "accent-muted": ["text-error", "3.84"],
    "primary-muted": ["text-error", "3.84"],
    "secondary-lighten-2": ["error-darken-3", "3.14"],
    "secondary-muted": ["text-error", "4.29"],
  },
  dracula: {
    "accent-lighten-2": ["error-darken-3", "3.87"],
    "accent-muted": ["error-lighten-3", "3.95"],
    "primary-lighten-2": ["error-darken-3", "4.28"],
    "primary-muted": ["error-lighten-3", "3.88"],
    "secondary-lighten-2": ["error-darken-3", "2.45"],
  },
  flexoki: {
    "accent-muted": ["error-lighten-3", "4.39"],
    "primary-lighten-2": ["error-darken-3", "3.39"],
  },
  gruvbox: {
    "accent-muted": ["text-error", "3.21"],
    "primary-lighten-2": ["error-darken-3", "4.30"],
    "primary-muted": ["text-error", "3.86"],
    "secondary-lighten-2": ["error-darken-3", "4.19"],
    "secondary-muted": ["text-error", "3.88"],
  },
  monokai: {
    "accent-muted": ["text-error", "2.98"],
    "primary-lighten-2": ["error-darken-3", "3.77"],
    "primary-muted": ["text-error", "3.77"],
    "secondary-lighten-2": ["error-darken-3", "2.48"],
  },
  nord: {
    "accent-muted": ["error-lighten-3", "3.93"],
    "primary-muted": ["error-lighten-3", "3.40"],
    "secondary-muted": ["error-lighten-3", "3.87"],
  },
  "rose-pine": {
    "secondary-lighten-2": ["error-darken-3", "2.08"],
  },
  "rose-pine-dawn": {
    "primary-lighten-2": ["error-darken-3", "4.18"],
    "secondary-lighten-2": ["error-darken-3", "2.71"],
  },
  "rose-pine-moon": {
    "accent-lighten-2": ["error-darken-3", "4.25"],
    "secondary-lighten-2": ["error-darken-3", "2.89"],
  },
  "solarized-dark": {
    "accent-lighten-2": ["error-darken-3", "3.51"],
    "accent-muted": ["error-lighten-3", "4.06"],
    "primary-lighten-2": ["error-darken-3", "4.10"],
    "primary-muted": ["error-lighten-3", "3.80"],
    "secondary-muted": ["error-lighten-3", "3.58"],
  },
  "solarized-light": {
    "accent-lighten-2": ["error-darken-3", "3.51"],
    "primary-lighten-2": ["error-darken-3", "4.10"],
  },
  "svg-export": {
    "accent-muted": ["error-lighten-3", "3.84"],
    "primary-muted": ["error-lighten-3", "3.83"],
    "secondary-muted": ["error-lighten-3", "4.20"],
  },
  "textual-dark": {
    "accent-muted": ["error-lighten-3", "3.93"],
    "primary-lighten-2": ["error-darken-3", "4.21"],
    "secondary-lighten-2": ["error-lighten-3", "2.28"],
  },
  "textual-light": {
    "primary-lighten-2": ["error-lighten-3", "2.28"],
    "secondary-lighten-2": ["error-darken-3", "4.21"],
  },
  "tokyo-night": {
    "accent-lighten-2": ["error-darken-3", "3.81"],
    "primary-lighten-2": ["error-darken-3", "3.73"],
    "secondary-lighten-2": ["error-darken-3", "3.45"],
  },
};

// The door's ground at a lower depth: the rung the depth presses it into,
// which is the one above unless the depth draws that like what stands beside
// the door, and then the nearest rung of the hue it draws apart. It turns on
// the variation's hues and the dial's tones too, so the looks there are the
// first, over every variation crossed with every dial position, to reach each
// ground the depth gives the door under a theme.
const pressedGround = (theme: string, variation: VariationName, shade: ShadeName, drawnAt: ColorDepth): ShadeRole =>
  shadeRole(
    lineageHue(VARIATIONS[variation].open, 0),
    pressedAt(getThemePalette(theme)!, { decor: { variation: VARIATIONS[variation], shade: SHADES[shade] }, depth: 0 }, drawnAt),
  );
const EVERY_LOOK: ReadonlyArray<readonly [VariationName, ShadeName]> = [
  ...LOOKS,
  ...VARIATION_NAMES.flatMap((variation) => SHADE_NAMES.map((shade) => [variation, shade] as const)),
];
function looksAt(theme: string, drawnAt: ColorDepth): ReadonlyArray<readonly [VariationName, ShadeName]> {
  const reached = new Set<ShadeRole>();
  return EVERY_LOOK.filter(([variation, shade]) => {
    const ground = pressedGround(theme, variation, shade, drawnAt);
    if (reached.has(ground)) return false;
    reached.add(ground);
    return true;
  });
}

interface Door {
  readonly variation: VariationName;
  readonly shade: ShadeName;
  readonly ink: ColorRgba;
  readonly ground: ColorRgba;
}

// One rig per depth for the whole file, each drawing every theme in turn:
// parse and compile of the bundled default is a rig's cost, and the sweep is
// split by theme only so each test stays inside the suite's time limit.
const DEPTHS = ["truecolor", "256", "ansi"] as const;
let rigs: Readonly<Record<(typeof DEPTHS)[number], SessionBar>>;
beforeAll(() => {
  rigs = {
    truecolor: sessionBar(`{ globals: { colorCompatibility: 'truecolor' } }`, COLS),
    "256": sessionBar(`{ globals: { colorCompatibility: '256' } }`, COLS),
    ansi: sessionBar(`{ globals: { colorCompatibility: 'ansi' } }`, COLS),
  };
});
afterAll(() => {
  for (const depth of DEPTHS) rigs[depth].dispose();
});

// The open door's ✖ under `theme` in each of `looks`, in their order.
function doorsUnder(bar: SessionBar, theme: string, looks: ReadonlyArray<readonly [VariationName, ShadeName]>): readonly Door[] {
  bar.pick("theme", theme);
  return looks.map(([variation, shade]) => {
    bar.pick("variation", variation);
    bar.pick("shade", shade);
    bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
    return { variation, shade, ...doorClose(bar.render(AT).text) };
  });
}

describe.each(THEMES)("under %s", (theme) => {
  let truecolor: readonly Door[];
  beforeAll(() => {
    truecolor = doorsUnder(rigs.truecolor, theme, LOOKS);
  });

  test("at truecolor, under every dial position and variation, the ✖ is a red its theme names, and clears the text floor on its ground, or no red its theme names can and it wears the one standing farthest off", () => {
    const palette = getThemePalette(theme)!;
    const shown = (name: string) => drawnColour(palette.get(name)!, ColorDepth.TRUECOLOR);
    const reds = new Set(ERROR_REDS.map((name) => shown(name).hex));
    const wrong: string[] = [];
    const listed = new Set<string>();
    for (const { variation, shade, ink, ground } of truecolor) {
      const named = groundOf(variation, shade);
      const ratio = contrastRatio(ink, ground);
      const where = `under ${variation} at ${shade} (on ${named}): ✖ ${ink.hex} on ${ground.hex} at ${ratio.toFixed(2)}:1`;
      // Never synthesised, on every ground: the palette-identity sweep draws
      // the bundled variation only.
      if (!reds.has(ink.hex)) wrong.push(`${where}, not a red its theme names`);
      // The listing is keyed by the ground's name, so the ground is held to it.
      if (ground.hex !== shown(named).hex) {
        wrong.push(`${where}, on a ground that is not ${named} (${shown(named).hex})`);
        continue;
      }
      const farthest = FARTHEST[theme]?.[named];
      if (farthest === undefined) {
        if (ratio < TEXT_MIN_CONTRAST) wrong.push(`${where}, under the floor and not listed`);
        continue;
      }
      listed.add(named);
      // A listed ground is one on which every red its theme names stands under
      // the floor, and the ✖ wears the one standing farthest off.
      const best = ERROR_REDS.map((name) => ({ name, ratio: contrastRatio(shown(name), ground) })).reduce((far, red) =>
        red.ratio > far.ratio ? red : far,
      );
      const [red, reached] = farthest;
      if (best.ratio >= TEXT_MIN_CONTRAST) wrong.push(`${where}, listed, yet ${best.name} clears the floor`);
      if (ink.hex !== shown(red).hex || ratio.toFixed(2) !== reached || reached !== best.ratio.toFixed(2)) {
        wrong.push(`${where}, listed as ${red} (${shown(red).hex}) at ${reached}:1; ${best.name} stands farthest, at ${best.ratio.toFixed(2)}:1`);
      }
    }
    expect(wrong).toEqual([]);
    // Every listing is still true: a ground the ✖ comes to clear leaves the list.
    expect(Object.keys(FARTHEST[theme] ?? {}).filter((named) => !listed.has(named))).toEqual([]);
    expect(truecolor.length).toBe(LOOKS.length);
  });

  test.each([
    ["256 colours", "256", ColorDepth.EIGHT_BIT],
    ["ansi", "ansi", ColorDepth.STANDARD],
  ] as const)(
    "at %s, rounding never costs the ✖ the contrast it has on the truecolor ground, and on a rung the depth presses the door into instead it stands as far off as the rule above puts a red there, up to the text floor",
    (_name, depth, drawnAt) => {
      const palette = getThemePalette(theme)!;
      const shown = (name: string) => drawnColour(palette.get(name)!, ColorDepth.TRUECOLOR);
      const onGround = new Map(truecolor.map((door) => [groundOf(door.variation, door.shade), door]));
      const looks = looksAt(theme, drawnAt);
      const wrong = doorsUnder(rigs[depth], theme, looks).flatMap(({ variation, shade, ink, ground }) => {
        const named = pressedGround(theme, variation, shade, drawnAt);
        const ratio = contrastRatio(ink, ground);
        const where = `under ${variation} at ${shade} (on ${named}): ✖ ${ink.hex} on ${ground.hex} at ${ratio.toFixed(2)}:1`;
        // As at truecolor, the ground is held to the name it is measured by.
        const drawn = drawnColour(palette.get(named)!, drawnAt);
        if (ground.hex !== drawn.hex) return [`${where}, on a ground that is not ${named} (${drawn.hex})`];
        const at = groundOf(variation, shade);
        const was = onGround.get(at);
        if (was === undefined) return [`${where}, whose truecolor ground ${at} no look at truecolor reaches`];
        // On the truecolor ground, rounded: the contrast the ✖ has there. On
        // another rung: what the rule gives the ✖ there as truecolor draws
        // it, which is the floor where a red its theme names clears it and
        // otherwise the farthest of them.
        const reach =
          named === at
            ? contrastRatio(was.ink, was.ground)
            : Math.max(...ERROR_REDS.map((red) => contrastRatio(shown(red), shown(named))));
        const held = Math.min(TEXT_MIN_CONTRAST, reach);
        return ratio >= held
          ? []
          : [`${where}, under the ${held.toFixed(2)}:1 it holds ${named === at ? "at truecolor" : `on ${named} at truecolor`}`];
      });
      expect(wrong).toEqual([]);
      expect(looks.length).toBeGreaterThan(0);
    },
  );
});
