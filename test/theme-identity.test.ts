// Every bundled theme's bar reads as that theme (brandon-theme-picker-bgw.8fp,
// candybar-theme-colours-6fq5.e5n).
//
// Facts, each measured on what the user sees — the bundled default bar,
// rendered under every palette through renderDsl — in ΔE_OK (rich-js
// `Oklch.deltaE`), where ~.02 is the smallest difference the eye resolves:
//
//   1. Every background the closed bar draws is a colour its theme names:
//      within PALETTE_FLOOR of a colour in its palette, under every variation
//      and every position of the shade dial, at the `none` style.
//   2. Two neighbouring cells never blur: every arrow joins two backgrounds at
//      least SEAM_MIN_DELTA_E apart, and where a theme's own colours put two
//      neighbours on one background the joiner draws the divider — with the
//      rate-limit windows hot and with them calm (the calm block and weekly
//      used to share `panel`, joined by an arrow nobody could see).
//
// A third fact held two distinct themes' bars ΔE .02 apart cell by cell while
// the bar's tints were synthesised and could erode a theme into its neighbour.
// A closed cell is now its theme's own role at a shade, so two themes that
// share their roles share their bars — Solarized's dark and light variants
// name every accent alike, as Textual draws them — and fact 1 is what holds
// a bar to its theme.

import {
  ColorDepth,
  ColorRgba,
  drawnColour,
  getThemePalette,
  listThemePalettes,
  Oklch,
  SEAM_MIN_DELTA_E,
} from "@promptctl/rich-js";

import { checkPayload } from "../src/check";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { unauthored, validateConfig } from "../src/config/dsl-loader";
import { resolveEffectiveGlobals } from "../src/daemon/render-payload";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  SHADES,
  VARIATIONS,
  type ShadeName,
  type VariationName,
} from "../src/themes/decor";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { instantOf } from "../src/utils/instant";

// About one just-noticeable step: how near a drawn background must sit to a
// colour its palette names (the ticket's own bound).
const PALETTE_FLOOR = 0.02;

const ARROW = "\u{e0b0}";
const DIVIDER = "\u{e0b1}";
const TOKEN = /\x1b\[([0-9;]*)m|\x1b\]8;[^\x1b]*\x1b\\/g;

const oklch = (c: ColorRgba): Oklch => Oklch.fromRgba(c);
const dE = (a: ColorRgba, b: ColorRgba): number => oklch(a).deltaE(oklch(b));

// A seam: the backgrounds either side and the glyph between them. The arrow
// is drawn in the left cell's background over the right cell's, so its
// (fg, bg) pair IS the seam. The divider is drawn in the left cell's TEXT
// colour on the right cell's background — the same style run as the left
// cell when the two backgrounds are byte-equal — so its left side is the
// background of the text just before it.
interface Seam {
  readonly left: ColorRgba;
  readonly right: ColorRgba;
  readonly glyph: string;
}

function seams(rendered: string): Seam[] {
  const out: Seam[] = [];
  for (const line of rendered.split("\n")) {
    let fg: ColorRgba | undefined;
    let bg: ColorRgba | undefined;
    let cellBg: ColorRgba | undefined;
    let pos = 0;
    const text = (t: string): void => {
      if (t.includes(ARROW)) {
        if (fg && bg) out.push({ left: fg, right: bg, glyph: ARROW });
        return;
      }
      t.split(DIVIDER).forEach((part, k) => {
        if (k > 0 && cellBg && bg) out.push({ left: cellBg, right: bg, glyph: DIVIDER });
        if (part.trim() && bg) cellBg = bg;
      });
    };
    for (const m of line.matchAll(TOKEN)) {
      text(line.slice(pos, m.index));
      pos = m.index + m[0].length;
      if (m[1] === undefined) continue;
      const p = m[1].split(";").map(Number);
      for (let i = 0; i < p.length; i++) {
        if (p[i] === 0) fg = bg = undefined;
        else if ((p[i] === 38 || p[i] === 48) && p[i + 1] === 2) {
          const c = new ColorRgba(p[i + 2]!, p[i + 3]!, p[i + 4]!);
          if (p[i] === 38) fg = c;
          else bg = c;
          i += 4;
        }
      }
    }
    text(line.slice(pos));
  }
  return out;
}

const THEMES = listThemePalettes();
const CONFIG = validateConfig(unauthored(DEFAULT_DSL_CONFIG), "<bundled default>");

// Each variation, position of the shade dial and bundled style is a runtime
// pick (brandon-theme-picker-bgw.7g6, candybar-theme-colours-6fq5.e5n), so
// each fact below holds whichever one the user is in, not only under the
// defaults: the palette fact under every variation × every position of the
// dial, unstyled, and the seam fact under every variation × position × style,
// since only the three together decide which two colours meet.
const VARIATION_NAMES = Object.keys(VARIATIONS) as VariationName[];
const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
const STYLES = Object.keys(CONFIG.styles);
interface Variant {
  readonly variation: VariationName;
  readonly shade: ShadeName;
  readonly look: string;
}
const named = ({ variation, shade, look }: Variant): string => `${variation}/${shade}/${look}`;
const UNSTYLED: readonly Variant[] = VARIATION_NAMES.flatMap((variation) =>
  SHADE_NAMES.map((shade) => ({ variation, shade, look: "none" })),
);
const VARIANTS: readonly Variant[] = VARIATION_NAMES.flatMap((variation) =>
  SHADE_NAMES.flatMap((shade) => STYLES.map((look) => ({ variation, shade, look }))),
);

// Every rate-limit window and the context calm: the case where the threshold
// cells wear their calm arm side by side.
const CALM = {
  context: { totalTokens: 48487, contextLeft: 80 },
  block: { nativeUtilization: 5 },
  weekly: { percentage: 4 },
};

// One compiled bar, rendered under each pick the way the daemon renders one
// config for many sessions: the selection is an argument, so nothing carries
// over between renders but the compiled config itself. One instant for every
// render, so the renders differ only in the pick.
const STORE = new VariableStore();
const REGISTRY = new SourceRegistry(STORE, "", undefined, new SessionState());
const COMPILED = registerDslConfig(CONFIG, REGISTRY, { cwd: process.cwd() });
const AT = instantOf(new Date());
afterAll(() => REGISTRY.dispose());

function render(theme: string, calm: boolean, { variation, shade, look }: Variant): string {
  const e = resolveEffectiveGlobals(
    CONFIG,
    (key) =>
      key === "theme"
        ? theme
        : key === "variation"
          ? variation
          : key === "shade"
            ? shade
            : key === "style"
              ? look
              : null,
    () => false,
  );
  const hot = checkPayload(e, null, AT) as Record<string, Record<string, unknown>>;
  const payload = calm
    ? Object.fromEntries(
        Object.entries(hot).map(([k, v]) => [
          k,
          k in CALM ? { ...v, ...CALM[k as keyof typeof CALM] } : v,
        ]),
      )
    : hot;
  return renderDsl(
    CONFIG,
    COMPILED,
    STORE,
    REGISTRY,
    payload,
    AT,
    {
      endcaps: e.endcaps,
      separator: e.separator,
      width: 400,
      colorCompatibility: e.colorCompatibility,
      wrap: e.autoWrap,
      padding: e.padding,
      charset: e.charset,
    },
    undefined,
    { theme: e.theme, style: e.style, preset: e.preset, variation: e.variation, shade: e.shade },
  );
}

// Each (theme, calm, variant) bar is rendered once, on first read INSIDE a
// test, so a render that throws fails that theme's test by name rather than
// the suite's collection — and both facts read the one render.
const BARS = new Map<string, string>();
function bar(theme: string, calm: boolean, variant: Variant): string {
  const key = `${theme}|${calm}|${named(variant)}`;
  const hit = BARS.get(key);
  if (hit !== undefined) return hit;
  const rendered = render(theme, calm, variant);
  BARS.set(key, rendered);
  return rendered;
}
const seamsOf = (theme: string, calm: boolean, variant: Variant): Seam[] =>
  seams(bar(theme, calm, variant));

// Every background colour a rendered bar draws, in order: each 48;2 SGR.
function backgrounds(rendered: string): ColorRgba[] {
  return [...rendered.matchAll(/\x1b\[([0-9;]*)m/g)].flatMap((m) => {
    const p = m[1]!.split(";").map(Number);
    const out: ColorRgba[] = [];
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 48 && p[i + 1] === 2) {
        out.push(new ColorRgba(p[i + 2]!, p[i + 3]!, p[i + 4]!));
        i += 4;
      }
    }
    return out;
  });
}

describe("done-when: every background the closed bar draws is a colour its theme names", () => {
  // The `none` style: the theme as it ships. A style transposes the whole
  // palette, shades and all, so under one the bar wears the transposed palette.
  test.each(UNSTYLED.map((v) => [named(v), v] as const))("under %s, within ΔE .02 of its palette, hot and calm, on every theme", (_name, variant) => {
    const wrong: string[] = [];
    let measured = 0;
    for (const theme of THEMES) {
      const palette = [...getThemePalette(theme)!.vars.values()].map((c) => drawnColour(c, ColorDepth.TRUECOLOR));
      // A colour the palette names exactly is ΔE 0 from it; only another is measured.
      const exact = new Set(palette.map((c) => c.hex));
      for (const calm of [false, true]) {
        for (const bg of backgrounds(bar(theme, calm, variant))) {
          measured++;
          if (exact.has(bg.hex)) continue;
          const nearest = Math.min(...palette.map((c) => dE(bg, c)));
          if (nearest > PALETTE_FLOOR) wrong.push(`${theme}${calm ? " calm" : ""} ${bg.hex} ${nearest.toFixed(3)}`);
        }
      }
    }
    expect(measured).toBeGreaterThan(THEMES.length * 2 * 5);
    expect([...new Set(wrong)]).toEqual([]);
  });
});

describe("no two neighbouring cells blur", () => {
  const seamsUnder = (variant: Variant) =>
    THEMES.flatMap((theme) =>
      [false, true].flatMap((calm) =>
        seamsOf(theme, calm, variant).map((seam) => ({ theme, calm, ...seam })),
      ),
    );

  // The joiner draws a divider where an arrow would vanish into the ground
  // it enters: where two neighbours' backgrounds meet. Cells nested in one bar
  // cell (context beside autocompact, and ceiling) wear that cell's colour
  // byte for byte (decorEntryFor), as do the cells of a muted row, and a
  // theme can draw two of its colours alike (textual-ansi's every shade of a
  // role is one colour). A divider between backgrounds the eye tells apart is
  // a seam the joiner gave up for nothing.
  test.each(VARIANTS.map((v) => [named(v), v] as const))("under %s: every theme is measured, every arrow joins backgrounds the eye tells apart, and a divider only backgrounds that meet", (_name, variant) => {
    const seams = seamsUnder(variant);
    expect(seams.length).toBeGreaterThan(THEMES.length * 2 * 5);
    const arrows = seams
      .filter((s) => s.glyph === ARROW && dE(s.left, s.right) < SEAM_MIN_DELTA_E)
      .map((s) => `${s.theme}${s.calm ? " calm" : ""} ${s.left.hex}|${s.right.hex}`);
    expect([...new Set(arrows)]).toEqual([]);
    const dividers = seams
      .filter((s) => s.glyph === DIVIDER && dE(s.left, s.right) >= SEAM_MIN_DELTA_E)
      .map((s) => `${s.theme}${s.calm ? " calm" : ""} ${s.left.hex}|${s.right.hex}`);
    expect([...new Set(dividers)]).toEqual([]);
  });

  test("dividers are drawn, so the divider rule has seams to judge", () => {
    // Non-vacuous: the rule judges every divider, and a muted row is one
    // colour, as is every shade of a role under textual-ansi.
    expect(VARIANTS.some((variant) => seamsUnder(variant).some((s) => s.glyph === DIVIDER))).toBe(true);
  });
});
