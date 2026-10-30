// [LAW:verifiable-goals] candybar-joiners-e5r4.i30: the settings door's open
// ✖ reads on the ground it is drawn on. It is red on every theme because it is
// always a red the theme names for its error role; it reads because it is one
// of those that clears TEXT_MIN_CONTRAST on its ground, and where none does,
// the one standing farthest off, on the themes listed below. Driven through the
// real loader, `resolveEffectiveGlobals` and `renderDsl`, under every bundled
// theme and dial position, at truecolor, 256 and ansi, each pair measured as
// the terminal draws it.

import { ColorDepth, contrastRatio, drawnColour, getThemePalette, listThemePalettes, type ColorRgba } from "@promptctl/rich-js";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SHADES, TEXT_MIN_CONTRAST, type RoleShade, type ShadeName } from "../src/themes/decor";
import { instantOf } from "../src/utils/instant";
import { ERROR_REDS, doorClose, type ErrorRed } from "./helpers/door-close";
import { sessionBar } from "./helpers/session-bar";

const THEMES = listThemePalettes();
const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
const COLS = 200;
const AT = instantOf(new Date("2026-10-30T12:00:00Z"));

// The themes on which no red they name clears the floor on the door's ground,
// by the rung the dial position presses the door into (its ground differs
// with it): the red the ✖ wears there, the one standing farthest off its
// ground, and the ratio it reaches at truecolor.
const FARTHEST: Readonly<Record<string, Partial<Record<RoleShade, readonly [ErrorRed, string]>>>> = {
  "atom-one-dark": { "lighten-2": ["error-darken-3", "3.31"] },
  "atom-one-light": { "lighten-2": ["error-darken-3", "4.31"] },
  "catppuccin-frappe": { muted: ["error-lighten-3", "4.00"] },
  "catppuccin-latte": { "lighten-2": ["error-darken-3", "4.38"] },
  "catppuccin-mocha": { "lighten-2": ["error-darken-3", "3.72"] },
  cyberpunk: { muted: ["text-error", "2.76"] },
  default: { muted: ["text-error", "3.84"] },
  dracula: { muted: ["error-lighten-3", "3.95"], "lighten-2": ["error-darken-3", "3.87"] },
  flexoki: { muted: ["error-lighten-3", "4.39"] },
  gruvbox: { muted: ["text-error", "3.21"] },
  monokai: { muted: ["text-error", "2.98"] },
  nord: { muted: ["error-lighten-3", "3.93"] },
  "rose-pine-moon": { "lighten-2": ["error-darken-3", "4.25"] },
  "solarized-dark": { muted: ["error-lighten-3", "4.06"], "lighten-2": ["error-darken-3", "3.51"] },
  "solarized-light": { "lighten-2": ["error-darken-3", "3.51"] },
  "svg-export": { muted: ["error-lighten-3", "3.84"] },
  "textual-dark": { muted: ["error-lighten-3", "3.93"] },
  "tokyo-night": { "lighten-2": ["error-darken-3", "3.81"] },
};

interface Door {
  readonly theme: string;
  readonly shade: ShadeName;
  readonly ink: ColorRgba;
  readonly ground: ColorRgba;
}

// The open door's ✖ under every bundled theme and dial position, in one
// order, at `compatibility`: one rig for the whole sweep.
function everyDoor(compatibility: string): readonly Door[] {
  const bar = sessionBar(`{ globals: { colorCompatibility: '${compatibility}' } }`, COLS);
  try {
    return THEMES.flatMap((theme) => {
      bar.pick("theme", theme);
      return SHADE_NAMES.map((shade) => {
        bar.pick("shade", shade);
        bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
        return { theme, shade, ...doorClose(bar.render(AT).text) };
      });
    });
  } finally {
    bar.dispose();
  }
}

let truecolor: readonly Door[];
beforeAll(() => {
  truecolor = everyDoor("truecolor");
});

test("at truecolor, under every bundled theme and dial position, the ✖ clears the text floor on its ground, or no red its theme names can and it wears the one standing farthest off", () => {
  const wrong: string[] = [];
  const listed = new Set<string>();
  for (const { theme, shade, ink, ground } of truecolor) {
    const activated = SHADES[shade].activated;
    const ratio = contrastRatio(ink, ground);
    const where = `${theme} at ${shade} (pressed to ${activated}): ✖ ${ink.hex} on ${ground.hex} at ${ratio.toFixed(2)}:1`;
    const farthest = FARTHEST[theme]?.[activated];
    if (farthest === undefined) {
      if (ratio < TEXT_MIN_CONTRAST) wrong.push(`${where}, under the floor and not listed`);
      continue;
    }
    listed.add(`${theme}/${activated}`);
    // A listed theme is one whose every red stands under the floor on this
    // ground, and the ✖ wears the one standing farthest off.
    const palette = getThemePalette(theme)!;
    const reds = ERROR_REDS.map((name) => ({
      name,
      ratio: contrastRatio(drawnColour(palette.get(name)!, ColorDepth.TRUECOLOR), ground),
    }));
    const best = reds.reduce((far, red) => (red.ratio > far.ratio ? red : far));
    const [red, reached] = farthest;
    const worn = drawnColour(palette.get(red)!, ColorDepth.TRUECOLOR).hex;
    if (best.ratio >= TEXT_MIN_CONTRAST) wrong.push(`${where}, listed, yet ${best.name} clears the floor`);
    if (ink.hex !== worn || ratio.toFixed(2) !== reached || reached !== best.ratio.toFixed(2)) {
      wrong.push(`${where}, listed as ${red} (${worn}) at ${reached}:1; ${best.name} stands farthest, at ${best.ratio.toFixed(2)}:1`);
    }
  }
  expect(wrong).toEqual([]);
  // Every listing is still true: a theme that comes to clear leaves the list.
  const stale = Object.entries(FARTHEST).flatMap(([theme, rungs]) =>
    Object.keys(rungs).map((rung) => `${theme}/${rung}`).filter((key) => !listed.has(key)),
  );
  expect(stale).toEqual([]);
  expect(truecolor.length).toBe(THEMES.length * SHADE_NAMES.length);
});

test.each([
  ["256 colours", "256"],
  ["ansi", "ansi"],
] as const)("at %s, rounding never costs the ✖ the contrast it has at truecolor, up to the text floor", (_name, compatibility) => {
  const lower = everyDoor(compatibility);
  const wrong = lower.flatMap(({ theme, shade, ink, ground }, i) => {
    const was = truecolor[i]!;
    // One sweep in one order: the same door at two depths.
    expect([was.theme, was.shade]).toEqual([theme, shade]);
    const held = Math.min(TEXT_MIN_CONTRAST, contrastRatio(was.ink, was.ground));
    const ratio = contrastRatio(ink, ground);
    return ratio >= held
      ? []
      : [`${theme} at ${shade}: ✖ ${ink.hex} on ${ground.hex} at ${ratio.toFixed(2)}:1, under the ${held.toFixed(2)}:1 it holds at truecolor`];
  });
  expect(wrong).toEqual([]);
  expect(lower.length).toBe(truecolor.length);
});
