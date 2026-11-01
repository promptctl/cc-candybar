// Every bundled theme's bar reads as that theme (brandon-theme-picker-bgw.8fp,
// candybar-theme-colours-6fq5.e5n).
//
// Facts, each measured on what the user sees — the bundled default bar,
// rendered under every palette through drawDsl — in ΔE_OK (rich-js
// `Oklch.deltaE`), where ~.02 is the smallest difference the eye resolves:
//
//   1. Every background the closed bar draws is a colour its theme names:
//      within PALETTE_FLOOR of a colour in its palette, under every variation
//      and every position of the shade dial, at the `none` style.
//   2. Two neighbouring cells never blur: every join is an arrow, and every
//      arrow joins two backgrounds at least SEAM_MIN_DELTA_E apart — with the
//      rate-limit windows hot and with them calm (the calm block and weekly
//      used to share `panel`, joined by an arrow nobody could see).
//
// A third fact held two distinct themes' bars ΔE .02 apart cell by cell while
// the bar's tints were synthesised and could erode a theme into its neighbour.
// A closed cell is now its theme's own role at a shade, so two themes that
// share their roles share their bars — Solarized's dark and light variants
// name every accent alike, as Textual draws them — and fact 1 is what holds
// a bar to its theme.

import { drawPayload } from "../test/helpers/draw-payload";
import type { Frame } from "../src/render/frame";
import { TEST_SIGNER } from "../test/helpers/link-signer";
import { DIVIDER, drawnChars, isRgb, seams, type Drawn } from "../test/helpers/seams";
import {
  ColorDepth,
  ColorRgba,
  ColorSpec,
  drawnColour,
  getThemePalette,
  listThemePalettes,
  Oklch,
  SEAM_MIN_DELTA_E,
} from "@promptctl/rich-js";

import { CHECK_TODAY, checkPayload } from "../src/check";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { validateConfig } from "../test/helpers/parse-and-validate";
import { unauthored } from "../src/config/dsl-loader";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig } from "../src/dsl/render";
import {
  SHADES,
  VARIATIONS,
  type ShadeName,
  type VariationName,
} from "../src/themes/decor";
import { processLauncher } from "../src/proc/launch";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { instantOf } from "../src/utils/instant";

// About one just-noticeable step: how near a drawn background must sit to a
// colour its palette names (the ticket's own bound).
const PALETTE_FLOOR = 0.02;

/** ΔE in OKLab, through rich-js's own arithmetic. */
const deltaE = (a: ColorRgba, b: ColorRgba): number => Oklch.fromRgba(a).deltaE(Oklch.fromRgba(b));

// A seam: the backgrounds either side and the glyph between them, read by the
// suite's one seam reader (test/helpers/seams.ts): the ground of the column
// drawn just before the glyph, and the ground the glyph is drawn on. An
// arrow's own ink is not read as its left side: the joiner draws it in the
// left cell's background only where that stands off the right one, and lifts
// it off the right one where it does not, so reading the ink would see two
// neighbours on one ground as an arrow between two. Every bar here is drawn in
// truecolor, so both grounds are RGB.
interface Seam {
  readonly left: ColorRgba;
  readonly right: ColorRgba;
  readonly glyph: string;
}

const rgba = (c: Drawn): ColorRgba => {
  if (!isRgb(c)) throw new Error(`a truecolor bar drew a seam on ansi slot ${c.ansi}`);
  return new ColorRgba(...c);
};

function seamsIn(rendered: Frame): Seam[] {
  const chars = drawnChars(rendered);
  // A divider is a seam too, so that one drawn anywhere is found and fails.
  const dividers = chars.flatMap(({ ch, bg, before }) =>
    ch === DIVIDER && before !== undefined && bg !== undefined ? [{ left: rgba(before), right: rgba(bg), glyph: ch }] : [],
  );
  const arrows = seams(chars).flatMap(({ glyph, left, right }) =>
    right === undefined ? [] : [{ left: rgba(left), right: rgba(right), glyph }],
  );
  return [...arrows, ...dividers];
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
const REGISTRY = new SourceRegistry(processLauncher, STORE, "", new SessionState());
const COMPILED = registerDslConfig(CONFIG, REGISTRY, { signer: TEST_SIGNER, cwd: process.cwd() });
const AT = instantOf(new Date());
afterAll(() => REGISTRY.dispose());

function render(theme: string, calm: boolean, { variation, shade, look }: Variant): Frame {
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
  const hot = {
    ...checkPayload(CONFIG, e, null, AT),
    today: CHECK_TODAY,
  } as unknown as Record<string, Record<string, unknown>>;
  const payload = calm
    ? Object.fromEntries(
        Object.entries(hot).map(([k, v]) => [
          k,
          k in CALM ? { ...v, ...CALM[k as keyof typeof CALM] } : v,
        ]),
      )
    : hot;
  return drawPayload(
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
    },
    undefined,
    e,
  ).frame;
}

// Each (theme, calm, variant) bar is rendered once, on first read INSIDE a
// test, so a render that throws fails that theme's test by name rather than
// the suite's collection — and both facts read the one render.
const BARS = new Map<string, Frame>();
function bar(theme: string, calm: boolean, variant: Variant): Frame {
  const key = `${theme}|${calm}|${named(variant)}`;
  const hit = BARS.get(key);
  if (hit !== undefined) return hit;
  const rendered = render(theme, calm, variant);
  BARS.set(key, rendered);
  return rendered;
}
const seamsOf = (theme: string, calm: boolean, variant: Variant): Seam[] =>
  seamsIn(bar(theme, calm, variant));

// Every truecolor background a drawn bar holds, in order.
function backgrounds({ rows }: Frame): ColorRgba[] {
  return rows.flatMap(({ runs }) =>
    runs.flatMap(({ bg }) =>
      bg?.startsWith("#") === true ? [ColorSpec.parse(bg).getTruecolor()] : [],
    ),
  );
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
          const nearest = Math.min(...palette.map((c) => deltaE(bg, c)));
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

  // Two neighbours on one ground are joined by an arrow the joiner lifts off
  // that ground: the seam shows, but the two cells still read as one. So every
  // seam must be an arrow between backgrounds the eye tells apart, and any
  // divider fails.
  test.each(VARIANTS.map((v) => [named(v), v] as const))("under %s: every theme is measured, every seam is an arrow, and every arrow joins backgrounds the eye tells apart", (_name, variant) => {
    const seams = seamsUnder(variant);
    expect(seams.length).toBeGreaterThan(THEMES.length * 2 * 5);
    const at = (s: (typeof seams)[number]) =>
      `${s.theme}${s.calm ? " calm" : ""} ${s.left.hex}|${s.right.hex}`;
    const arrows = seams
      .filter((s) => s.glyph !== DIVIDER && deltaE(s.left, s.right) < SEAM_MIN_DELTA_E)
      .map(at);
    expect([...new Set(arrows)]).toEqual([]);
    const dividers = seams.filter((s) => s.glyph === DIVIDER).map(at);
    expect([...new Set(dividers)]).toEqual([]);
  });
});
