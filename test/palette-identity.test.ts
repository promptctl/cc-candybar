// [LAW:verifiable-goals] candybar-joiners-e5r4.dg6: every background the bar
// draws is a colour its palette names — its closed cells, and, with the
// settings menu open on each tab, the segment that opened it, the ✕ and blank
// leads of its rows, the plane they sit on and their items, down to a picker
// open inside a tab — so both sides of every seam are colours the theme names.
// At 256 colours and ansi each is that colour rounded once, by the writer.
// candybar-joiners-e5r4.i30: the open door's ✖, text on the segment that
// opened the menu, is a red its palette names for its error role.
// Driven through the real loader, `resolveEffectiveGlobals` and `renderDsl`,
// under every bundled theme.

import {
  ColorDepth,
  ColorSpec,
  type ColorRgba,
  decodeAnsi,
  drawnColour,
  getThemePalette,
  listThemePalettes,
} from "@promptctl/rich-js";
import { DOOR_GLYPH } from "../src/config/disclosure";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { POLLED, SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/reserved-names";
import { resolvedStyle } from "../src/render/rich-theme";
import { SWATCH_GLYPH } from "../src/render/swatch";
import { DECOR_HUES, SHADES, shadeRole, type RoleShade, type ShadeName } from "../src/themes/decor";
import { instantOf } from "../src/utils/instant";
import { ERROR_REDS, doorClose } from "./helpers/door-close";
import { POWERLINE } from "./helpers/powerline";
import { LADDER } from "./helpers/decor-vocabulary";
import { sessionBar, type SessionBar } from "./helpers/session-bar";

const THEMES = listThemePalettes();
// Every shade of a role a cell can wear: the ladder and the muted form.
const ROLE_SHADES: readonly RoleShade[] = [...LADDER, "muted"];
const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
const TABS = ["session", "look", "layout", "config", "tools"] as const;
const COLS = 200;
const AT = instantOf(new Date("2026-10-30T12:00:00Z"));

// What the bar shows: closed; the settings menu open on each tab with the
// theme's ⚙ open in it; and the style picker opened inside that ⚙ — a band
// three deep. Each view sets every key it reads, so views compose in any order.
interface View {
  readonly name: string;
  readonly open: boolean;
  readonly show: (bar: SessionBar) => void;
}
const opened = (tab: string, picker: string | null) => (bar: SessionBar) => {
  bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
  bar.pick(`${SETTINGS_NS}tab`, tab);
  bar.pick(sharedMenuStateKey("candybar.pickers"), "gear");
  if (picker === null) bar.unpick(sharedMenuStateKey("candybar.gearPickers"));
  else bar.pick(sharedMenuStateKey("candybar.gearPickers"), picker);
};
const VIEWS: readonly View[] = [
  { name: "closed", open: false, show: (bar) => bar.pick(SETTINGS_ANCHOR, "closed") },
  ...TABS.map((tab) => ({ name: `${tab} tab`, open: true, show: opened(tab, null) })),
  { name: "style picker in the ⚙", open: true, show: opened("session", "candybar.apply.style") },
];

/**
 * Every visible character of a rendered frame with the background it is drawn
 * on, read through rich-js's `decodeAnsi`, the writer's inverse. The one
 * exemption is a swatch, which shows another palette's colours on purpose. An
 * authored `bg` is meaning, not policy; it needs no exemption only because
 * every one the bundled bar draws is a palette role (`warning`, `error`), and
 * an authored colour that is not belongs on this list.
 */
function grounds(rendered: string): { readonly ch: string; readonly at: string; readonly bg: ColorSpec }[] {
  return rendered.split("\n").flatMap((line, row) => {
    const text = decodeAnsi(line);
    return text.spans.flatMap(({ start, end, style }) => {
      const bg = resolvedStyle(style).bgcolor;
      if (bg === undefined) return [];
      // Columns counted in the string's own units, as `start` is, so two
      // depths that split one run into different spans place it alike.
      let column = start;
      return [...text.plain.slice(start, end)].flatMap((ch) => {
        const at = `row ${row} col ${column}`;
        column += ch.length;
        return ch === SWATCH_GLYPH ? [] : [{ ch, at, bg }];
      });
    });
  });
}

describe("every background the bar draws is a colour its palette names", () => {
  test.each(SHADE_NAMES)("at the %s dial position, under every bundled theme, closed and with the settings menu open", (shade) => {
    const bar = sessionBar(`{ globals: { colorCompatibility: 'truecolor' } }`, COLS);
    const wrong: string[] = [];
    let measured = 0;
    try {
      bar.pick("shade", shade);
      for (const theme of THEMES) {
        // A palette's colours as truecolor draws them: composited over black.
        const named = new Set(
          [...getThemePalette(theme)!.vars.values()].map((c) => drawnColour(c, ColorDepth.TRUECOLOR).hex),
        );
        bar.pick("theme", theme);
        VIEWS[0]!.show(bar);
        const barRows = bar.render(AT).text.split("\n").length;
        for (const view of VIEWS) {
          view.show(bar);
          const { text } = bar.render(AT);
          // Non-vacuous: an open view draws its menu above the bar.
          expect([theme, view.name, text.split("\n").length > barRows]).toEqual([theme, view.name, view.open]);
          for (const { ch, at, bg } of grounds(text)) {
            measured++;
            const hex = bg.value?.hex;
            if (hex === undefined || !named.has(hex)) wrong.push(`${theme} ${view.name} ${at} '${ch}': ${hex ?? bg.name}`);
          }
        }
      }
    } finally {
      bar.dispose();
    }
    expect(wrong).toEqual([]);
    expect(measured).toBeGreaterThan(THEMES.length * VIEWS.length * 100);
  });
});

describe("the open door's ✖ is a red its palette names for its error role", () => {
  test("under every bundled theme and every dial position, at truecolor", () => {
    const bar = sessionBar(`{ globals: { colorCompatibility: 'truecolor' } }`, COLS);
    const wrong: string[] = [];
    let measured = 0;
    try {
      for (const theme of THEMES) {
        const palette = getThemePalette(theme)!;
        const reds = new Map(ERROR_REDS.map((name) => [drawnColour(palette.get(name)!, ColorDepth.TRUECOLOR).hex, name]));
        bar.pick("theme", theme);
        for (const shade of SHADE_NAMES) {
          bar.pick("shade", shade);
          bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
          const { ink } = doorClose(bar.render(AT).text);
          measured++;
          if (!reds.has(ink.hex)) wrong.push(`${theme} at ${shade}: ✖ ${ink.hex}`);
        }
      }
    } finally {
      bar.dispose();
    }
    expect(wrong).toEqual([]);
    expect(measured).toBe(THEMES.length * SHADE_NAMES.length);
  });
});

// candybar-joiners-e5r4.686: a depth may deal a cell another shade of its role
// than truecolor does (a window narrowed to the shades it draws apart, or
// widened along the ladder; a pressed shade widened off what stands beside
// it), never a colour off that role's ladder and never one rounded twice.
describe("a lower depth draws each of those colours rounded once", () => {
  // The look the open first tab once met the ✕ beside it in at ansi, and the
  // default one.
  const LOOKS: readonly Readonly<Record<string, string>>[] = [{}, { shade: "deepest", variation: "duo" }];
  // The joiner's own cells: it draws a seam from its two neighbours as the
  // depth draws them, which is rich-js's to say, so only the cells either side
  // of it are held here.
  const JOINER = new Set<string>([POWERLINE.glyph, POWERLINE.lead, POWERLINE.tail]);

  test.each([
    ["256 colours", "256", ColorDepth.EIGHT_BIT],
    ["ansi", "ansi", ColorDepth.STANDARD],
  ] as const)("at %s, every background is the one truecolor draws there as the writer rounds it, or another shade of the same role as the writer rounds it, under every bundled theme and view", (_name, compatibility, depth) => {
    const truecolor = sessionBar(`{ globals: { colorCompatibility: 'truecolor' } }`, COLS);
    const lower = sessionBar(`{ globals: { colorCompatibility: '${compatibility}' } }`, COLS);
    const wrong: string[] = [];
    let measured = 0;
    try {
      for (const look of LOOKS) {
        for (const bar of [truecolor, lower]) for (const [key, value] of Object.entries(look)) bar.pick(key, value);
        for (const theme of THEMES) {
          for (const view of VIEWS) {
            const drawn = [truecolor, lower].map((bar) => {
              bar.pick("theme", theme);
              view.show(bar);
              return grounds(bar.render(AT).text);
            });
            const [full, rounded] = drawn as [ReturnType<typeof grounds>, ReturnType<typeof grounds>];
            const where = `${JSON.stringify(look)} ${theme} ${view.name}`;
            // One frame at two depths: the same characters on the same cells.
            expect([where, rounded.map((g) => `${g.at}${g.ch}`)]).toEqual([where, full.map((g) => `${g.at}${g.ch}`)]);
            const palette = getThemePalette(theme)!;
            const roundedOnce = (c: ColorRgba): string => ColorSpec.fromRgba(c).downgrade(depth).getAnsiCodes(false).join(";");
            // Every shade of each role the palette names `hex` as, rounded once.
            const shadesOf = (hex: string): Set<string> =>
              new Set(
                DECOR_HUES.filter((hue) => ROLE_SHADES.some((shade) => palette.get(shadeRole(hue, shade)).hex === hex)).flatMap(
                  (hue) => ROLE_SHADES.map((shade) => roundedOnce(palette.get(shadeRole(hue, shade)))),
                ),
              );
            full.forEach(({ ch, at, bg }, i) => {
              if (JOINER.has(ch)) return;
              measured++;
              // [LAW:no-defensive-null-guards] A truecolor frame draws every
              // background as an RGB value.
              const expected = roundedOnce(bg.value!);
              const got = rounded[i]!.bg.getAnsiCodes(false).join(";");
              if (got !== expected && !shadesOf(bg.value!.hex).has(got))
                wrong.push(`${where} ${at} '${ch}': ${bg.value!.hex} drawn ${got}, rounds to ${expected}, and is no shade of its role`);
            });
          }
        }
      }
    } finally {
      truecolor.dispose();
      lower.dispose();
    }
    expect(wrong).toEqual([]);
    expect(measured).toBeGreaterThan(LOOKS.length * THEMES.length * VIEWS.length * 100);
  });
});

// candybar-joiners-e5r4.3m7: the door and the frame-rate cell beside it are
// built as one unit, so every bar carries the rate wherever the door sits,
// but they sit side by side on the row's line, so they take two of its places.
describe("the settings door and its frame-rate cell take two places of the first row", () => {
  // A theme that names every tone of every window apart, so two cells of one
  // hue in two colours are two tones, and in one colour one.
  const THEME = "textual-dark";
  const palette = getThemePalette(THEME)!;
  // The background under the first character of `text` on the bar's first line.
  const groundUnder = (rendered: string, text: string): string | undefined => {
    const line = decodeAnsi(rendered.split("\n")[0]!);
    const at = line.plain.indexOf(text);
    const span = line.spans.find(({ start, end }) => start <= at && at < end);
    return span === undefined ? undefined : resolvedStyle(span.style).bgcolor?.value?.hex;
  };

  test("under every dial position, they wear two", () => {
    const bar = sessionBar(`{ globals: { colorCompatibility: 'truecolor' } }`, COLS);
    try {
      bar.pick("theme", THEME);
      VIEWS[0]!.show(bar);
      for (const shade of SHADE_NAMES) {
        for (const hue of DECOR_HUES) {
          const named = SHADES[shade].tones.map((tone) => palette.get(shadeRole(hue, tone)).hex);
          expect([shade, hue, new Set(named).size]).toEqual([shade, hue, named.length]);
        }
        bar.pick("shade", shade);
        const { text } = bar.render(AT);
        const door = groundUnder(text, DOOR_GLYPH);
        const rate = groundUnder(text, POLLED);
        expect([shade, door === undefined, rate === undefined]).toEqual([shade, false, false]);
        expect([shade, door]).not.toEqual([shade, rate]);
      }
    } finally {
      bar.dispose();
    }
  });
});
