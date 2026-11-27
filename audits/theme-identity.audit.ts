// Every bundled theme's bar reads as that theme (brandon-theme-picker-bgw.8fp,
// candybar-theme-colours-6fq5.e5n).
//
// The fact, measured on what the user sees — the bundled default bar,
// rendered under every palette through drawDsl — in ΔE_OK (rich-js
// `Oklch.deltaE`), where ~.02 is the smallest difference the eye resolves:
// every background the closed bar draws is a colour its theme names, within
// PALETTE_FLOOR of a colour in its palette, under every variation and every
// position of the shade dial, at the `none` style, with the rate-limit windows
// hot and with them calm.
//
// A fact that held two distinct themes' bars ΔE .02 apart cell by cell guarded
// against synthesised tints eroding a theme into its neighbour. A closed cell
// is its theme's own role at a shade, so two themes that share their roles
// share their bars — Solarized's dark and light variants name every accent
// alike, as Textual draws them — and the fact above is what holds a bar to its
// theme.

import { SAMPLE_REGION } from "../scripts/lib/draw-fixtures/sample-region.js";
import { drawPayload } from "../scripts/lib/draw-fixtures/draw-payload";
import type { Frame } from "../src/render/frame";
import { backgroundsOf, truecolorOf } from "../test/helpers/frame";
import { calmed } from "../test/helpers/seam-sweep";
import {
  ColorDepth,
  ColorRgba,
  drawnColour,
  getThemePalette,
  listThemePalettes,
  Oklch,
} from "@promptctl/rich-js";

import { samplePayload } from "../scripts/lib/draw-fixtures/sample-payload";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { validateConfig } from "../scripts/lib/draw-fixtures/parse-and-validate";
import { unauthored } from "../src/config/dsl-loader";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { SessionState } from "../src/renderer/session-state";
import { registerDslConfig } from "../src/dsl/render";
import {
  SHADES,
  VARIATIONS,
  type ShadeName,
  type VariationName,
} from "../src/themes/decor";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { instantOf } from "../src/utils/instant";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import { STYLE_FLOOR } from "../src/themes/policy";

// About one just-noticeable step: how near a drawn background must sit to a
// colour its palette names (the ticket's own bound).
const PALETTE_FLOOR = 0.02;

/** ΔE in OKLab, through rich-js's own arithmetic. */
const deltaE = (a: ColorRgba, b: ColorRgba): number =>
  Oklch.fromRgba(a).deltaE(Oklch.fromRgba(b));

const THEMES = listThemePalettes();
const CONFIG = validateConfig(
  unauthored(DEFAULT_DSL_CONFIG),
  "<bundled default>",
);

// Each variation and position of the shade dial is a runtime pick
// (brandon-theme-picker-bgw.7g6, candybar-theme-colours-6fq5.e5n), so the fact
// holds whichever one the user is in, not only under the defaults. The `none`
// style is the theme as it ships: a style transposes the whole palette, shades
// and all, so under one the bar wears the transposed palette.
const VARIATION_NAMES = Object.keys(VARIATIONS) as VariationName[];
const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
interface Variant {
  readonly variation: VariationName;
  readonly shade: ShadeName;
}
const named = ({ variation, shade }: Variant): string =>
  `${variation}/${shade}/${STYLE_FLOOR}`;
const UNSTYLED: readonly Variant[] = VARIATION_NAMES.flatMap((variation) =>
  SHADE_NAMES.map((shade) => ({ variation, shade })),
);

// One compiled bar, rendered under each pick the way the daemon renders one
// config for many sessions: the selection is an argument, so nothing carries
// over between renders but the compiled config itself. One instant for every
// render, so the renders differ only in the pick.
const STORE = new VariableStore(systemTimekeeper);
const REGISTRY = new SourceRegistry(STORE, SAMPLE_REGION, "", new SessionState());
const COMPILED = registerDslConfig(CONFIG, REGISTRY, {
  cwd: process.cwd(),
});
const AT = instantOf(new Date());
afterAll(() => REGISTRY.dispose());

// Rendered INSIDE a test, so a render that throws fails that variant's test by
// name rather than the suite's collection.
function bar(theme: string, calm: boolean, { variation, shade }: Variant): Frame {
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
              ? STYLE_FLOOR
              : null,
    () => false,
  );
  const hot = samplePayload(CONFIG, e, null, AT);
  return drawPayload(
    CONFIG,
    COMPILED,
    STORE,
    REGISTRY,
    calm ? calmed(hot) : hot,
    AT,
    {
      endcaps: e.endcaps,
      separator: e.separator,
      width: 400,
      colorCompatibility: e.colorCompatibility,
      wrap: e.autoWrap,
      padding: e.padding,
    },
    e,
  ).frame;
}

// Every truecolor background a drawn bar holds, in order.
function backgrounds(frame: Frame): ColorRgba[] {
  return backgroundsOf(frame).flatMap((bg) =>
    bg?.startsWith("#") === true ? [truecolorOf(bg)] : [],
  );
}

describe("done-when: every background the closed bar draws is a colour its theme names", () => {
  test.each(UNSTYLED.map((v) => [named(v), v] as const))(
    "under %s, within ΔE .02 of its palette, hot and calm, on every theme",
    (_name, variant) => {
      const wrong: string[] = [];
      let measured = 0;
      for (const theme of THEMES) {
        const palette = [...getThemePalette(theme)!.vars.values()].map((c) =>
          drawnColour(c, ColorDepth.TRUECOLOR),
        );
        // A colour the palette names exactly is ΔE 0 from it; only another is measured.
        const exact = new Set(palette.map((c) => c.hex));
        for (const calm of [false, true]) {
          for (const bg of backgrounds(bar(theme, calm, variant))) {
            measured++;
            if (exact.has(bg.hex)) continue;
            const nearest = Math.min(...palette.map((c) => deltaE(bg, c)));
            if (nearest > PALETTE_FLOOR)
              wrong.push(
                `${theme}${calm ? " calm" : ""} ${bg.hex} ${nearest.toFixed(3)}`,
              );
          }
        }
      }
      expect(measured).toBeGreaterThan(THEMES.length * 2 * 5);
      expect([...new Set(wrong)]).toEqual([]);
    },
  );
});
