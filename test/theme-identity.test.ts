// Every bundled theme's bar reads as that theme (brandon-theme-picker-bgw.8fp).
//
// Three facts, each measured on what the user sees — the bundled default bar,
// rendered under every palette through renderDsl — in ΔE_OK (rich-js
// `Oklch.deltaE`), where ~.02 is the smallest difference the eye resolves:
//
//   1. A tint carries its theme's colour: its chroma is DECOR_CHROMA_SHARE of
//      the way to its hue's, unless the sRGB gamut at the tint's lightness
//      cannot hold that much, in which case it holds all the gamut allows.
//   2. Two distinct themes' bars differ cell by cell — the difference a user
//      sees when they switch — by at least THEME_FLOOR on average.
//   3. Two neighbouring cells never blur: every arrow joins two backgrounds at
//      least SEAM_MIN_DELTA_E apart, and where a theme's own colours put two
//      neighbours on one background the joiner draws the divider — with the
//      rate-limit windows hot and with them calm (the calm block and weekly
//      used to share `panel`, joined by an arrow nobody could see).

import {
  ColorRgba,
  getThemePalette,
  listThemePalettes,
  Oklch,
  SEAM_MIN_DELTA_E,
} from "@promptctl/rich-js";

import { checkPayload } from "../src/check";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { validateConfig } from "../src/config/dsl-loader";
import { resolveEffectiveGlobals } from "../src/daemon/render-payload";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  DECOR_CHROMA_SHARE,
  DECOR_VOCABULARY,
  decorEntryColour,
  paletteRole,
} from "../src/themes/decor";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";

// The eye's resolution: two bars closer than ~.02 read as one theme. The
// measured minimum over the registry is .024, between rose-pine and
// rose-pine-moon — two variants of one family sharing their accents — on the
// seven-cell bundled bar (it was .029 while the bar carried an eighth cell, the
// settings drawer that moved into the menu). Before 8fp, dracula and
// rose-pine-moon sat at .018, under it.
const THEME_FLOOR = 0.02;

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
const CONFIG = validateConfig(DEFAULT_DSL_CONFIG, "<bundled default>", "");

// Every rate-limit window and the context calm: the case where the threshold
// cells wear their calm arm side by side.
const CALM = {
  context: { totalTokens: 48487, contextLeft: 80 },
  block: { nativeUtilization: 5 },
  weekly: { percentage: 4 },
};

function render(theme: string, calm: boolean): string {
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(CONFIG, registry, { cwd: process.cwd() });
    const e = resolveEffectiveGlobals(
      CONFIG,
      (key) => (key === "theme" ? theme : null),
      () => false,
    );
    const hot = checkPayload(e) as Record<string, Record<string, unknown>>;
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
      compiled,
      store,
      registry,
      payload,
      {
        style: e.style,
        separator: e.separator,
        width: 400,
        colorCompatibility: e.colorCompatibility,
        wrap: e.autoWrap,
        padding: e.padding,
        charset: e.charset,
      },
      undefined,
      { theme: e.theme, look: e.look, preset: e.preset },
    );
  } finally {
    registry.dispose();
  }
}

// Each (theme, calm) bar is rendered once, on first read INSIDE a test, so a
// render that throws fails that theme's test by name rather than the suite's
// collection.
const SEAMS = new Map<string, Seam[]>();
function seamsOf(theme: string, calm: boolean): Seam[] {
  const key = `${theme}|${calm}`;
  const hit = SEAMS.get(key);
  if (hit !== undefined) return hit;
  const measured = seams(render(theme, calm));
  SEAMS.set(key, measured);
  return measured;
}

describe("a tint carries its theme's colour", () => {
  test.each(THEMES)("%s: chroma is the share of its hue's, or all the gamut allows", (name) => {
    const palette = getThemePalette(name)!;
    for (const entry of DECOR_VOCABULARY) {
      const tint = oklch(decorEntryColour(palette, entry));
      // Both ends of the tone axis keep `surface`'s chroma and move it the
      // share of the way to the hue's, so every tone aims at the same chroma.
      const base = oklch(paletteRole(palette, "surface"));
      const hue = oklch(paletteRole(palette, entry.hue));
      const target = base.c + (hue.c - base.c) * DECOR_CHROMA_SHARE;
      // The most chroma sRGB can show at this lightness and hue: rich-js
      // clamps an out-of-gamut request to exactly that.
      const gamut = oklch(new Oklch(tint.l, 0.5, hue.h).toRgba()).c;
      // .004 absorbs the 8-bit quantisation of the stored colour.
      expect([name, entry, tint.c >= Math.min(target, gamut) - 0.004]).toEqual([
        name,
        entry,
        true,
      ]);
    }
  });
});

describe("the bar under one theme reads as that theme", () => {
  const cells = (theme: string) => seamsOf(theme, false).map((s) => s.right);
  const pairs = THEMES.flatMap((a, i) => THEMES.slice(i + 1).map((b) => [a, b] as const));

  test.each(pairs)("%s and %s differ cell by cell", (a, b) => {
    const A = cells(a);
    const B = cells(b);
    // One config, one payload: the two bars have the same cells in the same
    // order, so the k-th seam of each is the same cell under two themes.
    expect(A.length).toBe(B.length);
    const mean = A.reduce((sum, c, k) => sum + dE(c, B[k]!), 0) / A.length;
    expect([a, b, mean >= THEME_FLOOR]).toEqual([a, b, true]);
  });
});

describe("no two neighbouring cells blur", () => {
  const all = () =>
    THEMES.flatMap((theme) =>
      [false, true].flatMap((calm) => seamsOf(theme, calm).map((seam) => ({ theme, calm, ...seam }))),
    );

  test("every theme, hot and calm, is measured", () => {
    expect(all().length).toBeGreaterThan(THEMES.length * 2 * 5);
  });

  test("an arrow always joins two backgrounds the eye tells apart", () => {
    for (const s of all().filter((s) => s.glyph === ARROW)) {
      expect([s.theme, s.calm, s.left.hex, s.right.hex, dE(s.left, s.right) >= SEAM_MIN_DELTA_E]).toEqual([
        s.theme,
        s.calm,
        s.left.hex,
        s.right.hex,
        true,
      ]);
    }
  });

  // A theme folds its tones when two of one hue sit closer than the eye
  // resolves: the tone axis runs from `surface` receded toward `background`
  // to `surface` pulled toward the hue, so a theme whose hue sits at its
  // surface's lightness (textual-ansi) has almost no axis to spread over.
  // Neighbours share a background because the THEME says so, and the divider
  // keeps that seam.
  const foldsTones = (name: string): boolean => {
    const palette = getThemePalette(name)!;
    return DECOR_VOCABULARY.some((a) =>
      DECOR_VOCABULARY.some(
        (b) =>
          a.hue === b.hue &&
          a.tone !== b.tone &&
          dE(decorEntryColour(palette, a), decorEntryColour(palette, b)) < SEAM_MIN_DELTA_E,
      ),
    );
  };

  test("a divider joins only backgrounds the eye cannot, in a theme whose own tones fold", () => {
    const dividers = all().filter((s) => s.glyph === DIVIDER);
    // Non-vacuous: some bundled theme (textual-ansi) folds its tones, so the
    // loop below has seams to judge.
    expect(dividers.length).toBeGreaterThan(0);
    for (const s of dividers) {
      expect([s.theme, s.left.hex, s.right.hex, dE(s.left, s.right) < SEAM_MIN_DELTA_E, foldsTones(s.theme)])
        .toEqual([s.theme, s.left.hex, s.right.hex, true, true]);
    }
  });
});
