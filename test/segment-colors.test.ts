// [LAW:behavior-not-structure] Tests assert observable output (resolved hex
// values, Style fields, thrown errors) — never internal state.
//
// The seam under test: a segment's `bg:`/`fg:` fields are TEMPLATES that
// evaluate to a **color reference** — a palette variable name, or a computed
// `#RRGGBB` produced by rich-js's color math. `resolveSegmentColors` owns the
// ordered phase sequence (publish palette → resolve bg → publish bg → resolve
// fg), which is what makes `{{ bgOf }}` readable in a `fg:` template and an
// error in a `bg:` one.

import {
  Palette,
  parseRgbHex,
  ColorRgba,
  Oklch,
  darken,
  blendRgb,
  contrastFor,
} from "@promptctl/rich-js";
import { createCcCandybarEngine } from "../src/template-engine/engine";
import {
  resolveSegmentColors,
  ColorSpecError,
} from "../src/template-engine/colors";
import { createActiveSegmentRef } from "../src/render/active-segment";
import type { ActiveSegmentRef } from "../src/render/active-segment";
import { segmentColorFuncs } from "../src/render/segment-color";
import type { Disclosure } from "../src/themes/decor";
import {
  transposedPalette,
  paletteForThemeName,
} from "../src/themes/palette-resolvers";
import type { Template } from "@promptctl/go-template-js";
import type { RichText, Style, ThemeKey } from "@promptctl/rich-js";

// ─── Test palette ─────────────────────────────────────────────────────────────

function makeTestPalette(name = "test", primaryHex = "4488ff"): Palette {
  const vars = new Map<string, ColorRgba>([
    ["primary", parseRgbHex(primaryHex)],
    ["error", parseRgbHex("ff4444")],
    ["info", parseRgbHex("44aaff")],
    ["success", parseRgbHex("44cc88")],
    ["surface", parseRgbHex("1a1a2e")],
    ["text", parseRgbHex("eeeeee")],
    // transposePalette derives the dark flag from "background" (required for
    // any non-identity key); real registry palettes always carry it.
    ["background", parseRgbHex("12121a")],
  ]);
  return new Palette(name, true, vars);
}

// ─── Harness ──────────────────────────────────────────────────────────────────
//
// The exact wiring renderDsl uses: ONE ActiveSegmentRef, an engine whose
// segment-scoped funcs (`color`, `bgOf`) read through it, and
// resolveSegmentColors publishing into it. The templates are parsed once and
// the palette arrives per call — which is the whole point of the seam.

const SEG = "demo";

interface Harness {
  readonly ref: ActiveSegmentRef;
  parse(src: string): Template<RichText>;
}

function makeHarness(): Harness {
  const ref = createActiveSegmentRef();
  const engine = createCcCandybarEngine(segmentColorFuncs(ref));
  return { ref, parse: (src: string) => engine.parse(src) };
}

function resolve(
  h: Harness,
  palette: Palette,
  bg: Template<RichText> | undefined,
  fg: Template<RichText> | undefined,
  scope: object = {},
  text: ColorRgba | undefined = undefined,
): Style {
  return resolveSegmentColors(
    h.ref,
    SEG,
    palette,
    DISCLOSURE,
    TINT,
    text,
    bg,
    fg,
    scope,
  );
}

// This file is about bg/fg resolution; the disclosure only rides the record.
const DISCLOSURE: Disclosure = { hue: "primary", depth: 0 };
// The tint the walk dealt this segment's address — a colour no palette role
// here spells, so a background equal to it can only have come from the floor.
const TINT = parseRgbHex("102030");
// The text the walk chose for a band cell — likewise unspelled by any role.
const TEXT = parseRgbHex("f0e0d0");

// ────────────────────────────────────────────────────────────────────────────
// 1. No bg template → the tint IS the background (a segment always has one);
//    no fg template → no foreground override.
// ────────────────────────────────────────────────────────────────────────────

describe("no bg/fg templates → the tint, and no foreground", () => {
  test("undefined bg → the address's tint; undefined fg → color unset", () => {
    const style = resolve(
      makeHarness(),
      makeTestPalette(),
      undefined,
      undefined,
    );
    expect(style.bgcolor?.value?.hex).toBe(TINT.hex);
    expect(style.color).toBeUndefined();
  });

  test("an authored bg paints over the tint — meaning outranks decoration", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), h.parse("error"), undefined);
    expect(style.bgcolor?.value?.hex).toBe("#ff4444");
  });

  test("undefined fg → the region's text, when the walk chose one", () => {
    const style = resolve(
      makeHarness(),
      makeTestPalette(),
      undefined,
      undefined,
      {},
      TEXT,
    );
    expect(style.color?.value?.hex).toBe(TEXT.hex);
  });

  test("an authored fg paints over the region's text", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), undefined, h.parse("error"), {}, TEXT);
    expect(style.color?.value?.hex).toBe("#ff4444");
  });

  test("{{ bgOf }} in a fg template reads the tint when no bg is authored", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), undefined, h.parse("{{ bgOf }}"));
    expect(style.color?.value?.hex).toBe(TINT.hex);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Color references: a bare palette name and a computed hex take ONE path
// ────────────────────────────────────────────────────────────────────────────

describe("bg/fg color references", () => {
  test("bare name resolves to the palette color", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), h.parse("error"), undefined);
    expect(style.isNull).toBe(false);
    expect(style.bgcolor?.value?.hex).toBe("#ff4444");
  });

  test("a computed color reference resolves through the same path as a name", () => {
    // The name-authored form and the computed form are the identical code path
    // (resolveColorRef is idempotent on hex), so `darken (color "primary") 1`
    // must land exactly on rich-js's own darken of the palette's primary.
    const h = makeHarness();
    const palette = makeTestPalette();
    const style = resolve(
      h,
      palette,
      h.parse('{{ darken (color "primary") 1 }}'),
      undefined,
    );
    expect(style.isNull).toBe(false);
    expect(style.bgcolor?.value?.hex).not.toBe("#4488ff");
    expect(style.bgcolor?.value?.hex).toBe(
      darken(palette.get("primary")!, 1).hex,
    );
  });

  test("static fg resolves without bg context", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), undefined, h.parse("text"));
    expect(style.color?.value?.hex).toBe("#eeeeee");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. bg template with conditional — different references based on variable state
// ────────────────────────────────────────────────────────────────────────────

describe("conditional bg template", () => {
  const h = makeHarness();
  const palette = makeTestPalette();
  const bgTpl = h.parse(
    "{{ if gt .percent 90.0 }}error{{ else if gt .percent 75.0 }}info{{ else }}success{{ end }}",
  );

  test("percent > 90 → error color", () => {
    const style = resolve(h, palette, bgTpl, undefined, { percent: 95 });
    expect(style.bgcolor?.value?.hex).toBe("#ff4444");
  });

  test("percent 76–90 → info color", () => {
    const style = resolve(h, palette, bgTpl, undefined, { percent: 80 });
    expect(style.bgcolor?.value?.hex).toBe("#44aaff");
  });

  test("percent ≤ 75 → success color", () => {
    const style = resolve(h, palette, bgTpl, undefined, { percent: 50 });
    expect(style.bgcolor?.value?.hex).toBe("#44cc88");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. The phase sequence: what a `bg:` template may read vs a `fg:` one
// ────────────────────────────────────────────────────────────────────────────

describe("phase ordering — palette, then bg, then fg", () => {
  test("the palette is live inside the bg phase ({{ color }} resolves there)", () => {
    // Phase 0 publishes the palette BEFORE the bg template runs, so a bg field
    // may name a theme color through the same `{{ color }}` a body uses.
    const h = makeHarness();
    const style = resolve(
      h,
      makeTestPalette(),
      h.parse('{{ color "primary" }}'),
      undefined,
    );
    expect(style.bgcolor?.value?.hex).toBe("#4488ff");
  });

  test("{{ bgOf }} in a fg template returns the segment's resolved background", () => {
    const h = makeHarness();
    const style = resolve(
      h,
      makeTestPalette(),
      h.parse("surface"),
      h.parse("{{ bgOf }}"),
    );
    expect(style.bgcolor?.value?.hex).toBe("#1a1a2e");
    expect(style.color?.value?.hex).toBe(style.bgcolor?.value?.hex);
  });

  test("{{ bgOf }} inside a bg template throws, naming the phase", () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      resolve(h, makeTestPalette(), h.parse("{{ bgOf }}"), undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(`segments.${SEG}`);
    expect(message).toContain("background");
  });

  test("segment-scoped funcs outside any segment throw, saying so", () => {
    // A fresh ref is never published into — the state a variable declaration or
    // a layout-node `when` predicate evaluates in.
    const h = makeHarness();
    expect(h.ref.current).toBeNull();
    expect(() => h.parse("{{ bgOf }}").evaluate({})).toThrow(
      /no active segment/,
    );
    expect(() => h.parse('{{ color "primary" }}').evaluate({})).toThrow(
      /no active segment/,
    );
  });

  test("the published palette is the one passed in, not one captured at parse", () => {
    // Two clocks closed: ONE parsed template, two palettes, two answers. A
    // palette captured when the config loaded would make these identical while
    // the rest of the render moved on (a theme click, a look, a hue shift).
    const h = makeHarness();
    const bgTpl = h.parse('{{ color "primary" }}');
    const blue = resolve(
      h,
      makeTestPalette("blue", "4488ff"),
      bgTpl,
      undefined,
    );
    const green = resolve(
      h,
      makeTestPalette("green", "22bb66"),
      bgTpl,
      undefined,
    );
    expect(blue.bgcolor?.value?.hex).toBe("#4488ff");
    expect(green.bgcolor?.value?.hex).toBe("#22bb66");
    expect(blue.bgcolor?.value?.hex).not.toBe(green.bgcolor?.value?.hex);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. fg computed from the resolved bg — contrast and blending
// ────────────────────────────────────────────────────────────────────────────

describe("fg computed from bgOf", () => {
  test("contrastOn (bgOf) over a dark bg resolves to a light color", () => {
    const h = makeHarness();
    const palette = makeTestPalette();
    const style = resolve(
      h,
      palette,
      h.parse("surface"), // dark: #1a1a2e
      h.parse("{{ contrastOn (bgOf) }}"),
    );
    expect(style.color?.value?.hex).toBe(
      contrastFor(palette.get("surface")!).hex,
    );
    // …and that answer is a light one on a dark background.
    const hex = style.color!.value!.hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    expect((r + g + b) / 3).toBeGreaterThan(128);
  });

  test("mix (bgOf) (color …) 50 blends the fg halfway toward the bg", () => {
    const h = makeHarness();
    const palette = makeTestPalette();
    const style = resolve(
      h,
      palette,
      h.parse("surface"),
      h.parse('{{ mix (bgOf) (color "primary") 50 }}'),
    );
    expect(style.isNull).toBe(false);
    expect(style.color?.value?.hex).toBe(
      blendRgb(palette.get("surface")!, palette.get("primary")!, 0.5).hex,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Invalid color reference surfaces clearly at render time
// ────────────────────────────────────────────────────────────────────────────

describe("invalid color reference → ColorSpecError", () => {
  test("unknown bg name throws ColorSpecError", () => {
    const h = makeHarness();
    expect(() =>
      resolve(h, makeTestPalette(), h.parse("nonexistent-color"), undefined),
    ).toThrow(ColorSpecError);
  });

  test("unknown fg name throws ColorSpecError", () => {
    const h = makeHarness();
    expect(() =>
      resolve(h, makeTestPalette(), undefined, h.parse("totally-bogus")),
    ).toThrow(ColorSpecError);
  });

  test("error message names the reference and the role", () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      resolve(h, makeTestPalette(), h.parse("not-a-real-color"), undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ColorSpecError);
    expect((caught as ColorSpecError).message).toContain("not-a-real-color");
    expect((caught as ColorSpecError).message).toContain("bg");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Segment-scoped color funcs reach a template body only via segmentColorFuncs
// ────────────────────────────────────────────────────────────────────────────

describe("segment color functions in the engine", () => {
  test('{{ fg (color "primary") … }} paints the palette color', () => {
    const ref = createActiveSegmentRef();
    const engine = createCcCandybarEngine(segmentColorFuncs(ref));
    const tpl = engine.parse('{{ fg (color "primary") "hello" }}');
    ref.current = {
      segName: SEG,
      palette: makeTestPalette(),
      disclosure: DISCLOSURE,
      bg: undefined,
    };
    const fragments = tpl.evaluate({});
    expect(fragments[0]?.style?.color?.value?.hex).toBe("#4488ff");
    expect(fragments[0]?.plain).toBe("hello");
  });

  test("an engine built without segmentColorFuncs has no `color` function", () => {
    const engine = createCcCandybarEngine(); // no segment-scoped funcs
    const tpl = engine.parse('{{ color "primary" }}');
    expect(() => tpl.evaluate({})).toThrow(/"color" is not registered/);
  });

  test("an engine built without segmentColorFuncs has no `bgOf` function", () => {
    const engine = createCcCandybarEngine();
    const tpl = engine.parse("{{ bgOf }}");
    expect(() => tpl.evaluate({})).toThrow(/"bgOf" is not registered/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. Both bg and fg resolved — Style carries both colors
// ────────────────────────────────────────────────────────────────────────────

describe("both bg and fg resolved", () => {
  test("Style has both bgcolor and color set", () => {
    const h = makeHarness();
    const style = resolve(
      h,
      makeTestPalette(),
      h.parse("surface"),
      h.parse("text"),
    );
    expect(style.bgcolor?.value?.hex).toBe("#1a1a2e");
    expect(style.color?.value?.hex).toBe("#eeeeee");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 9. Per-segment hue = WHICH palette (whole-theme transposition)
//
// [LAW:behavior-not-structure] The hue behavior is a property of the palette
// handed to resolveSegmentColors, not an option of it. These assert the
// observable: resolved hex through a transposed palette. The anchor rule itself
// (error/success/warning hue-locked, info NOT) is owned + exhaustively tested in
// rich-js (transposePalette / ANCHORED_ROOTS); here we assert only that
// cc-candybar wires it through correctly.
// ────────────────────────────────────────────────────────────────────────────

// Per-channel max delta — sRGB↔OKLCH round-trips quantize by ±1.
function maxChannelDelta(a: ColorRgba, b: ColorRgba): number {
  return Math.max(
    Math.abs(a.red - b.red),
    Math.abs(a.green - b.green),
    Math.abs(a.blue - b.blue),
  );
}

describe("per-segment hue via palette transposition", () => {
  const base = makeTestPalette();
  // A hue-only ThemeKey — the shape renderDsl composes for a segment when no
  // look is active (the other three axes identity).
  const hueKey = (hueShift: number): ThemeKey => ({
    hueShift,
    chromaScale: 1,
    lightnessScale: 1,
    lightnessShift: 0,
  });

  test("hueShift 0 → identity: resolved color is byte-exact to base", () => {
    const shifted = transposedPalette(base, hueKey(0));
    expect(maxChannelDelta(shifted.get("primary")!, base.get("primary")!)).toBe(
      0,
    );
  });

  test("hueShift 30 → non-anchored color shifts substantially", () => {
    const shifted = transposedPalette(base, hueKey(30));
    expect(
      maxChannelDelta(shifted.get("primary")!, base.get("primary")!),
    ).toBeGreaterThan(5);
  });

  test("hueShift 30 → anchored names (error/success) keep their hue", () => {
    const shifted = transposedPalette(base, hueKey(30));
    // error/success are in rich-js ANCHORED_ROOTS: hue-locked under transpose,
    // so they survive within round-trip tolerance while primary (above) moves.
    expect(
      maxChannelDelta(shifted.get("error")!, base.get("error")!),
    ).toBeLessThanOrEqual(2);
    expect(
      maxChannelDelta(shifted.get("success")!, base.get("success")!),
    ).toBeLessThanOrEqual(2);
  });

  test("hueShift 30 → 'info' is NOT anchored (transposes like any color)", () => {
    // The old local SEMANTIC_SPECS list exempted 'info'; rich-js ANCHORED_ROOTS
    // does not. This is the drift the reshaping removed.
    const shifted = transposedPalette(base, hueKey(30));
    expect(
      maxChannelDelta(shifted.get("info")!, base.get("info")!),
    ).toBeGreaterThan(5);
  });

  test("memoized: same (palette, hueShift) returns the same palette instance", () => {
    expect(transposedPalette(base, hueKey(30))).toBe(
      transposedPalette(base, hueKey(30)),
    );
  });

  test("literal fg is transposed too (bg/fg pair preserved, not output-only)", () => {
    // The key fix: transposing the whole palette means a LITERAL fg reference
    // shifts alongside bg. The old output-only bg rotation left a literal fg
    // un-shifted, drifting the theme-designed bg/fg relationship apart.
    const h = makeHarness();
    const shifted = transposedPalette(base, hueKey(60));
    const bgTpl = h.parse("surface");
    const fgTpl = h.parse("info");
    const style = resolve(h, shifted, bgTpl, fgTpl);
    const baseStyle = resolve(h, base, bgTpl, fgTpl);
    expect(style.color?.value?.hex).not.toBe(baseStyle.color?.value?.hex);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 9b. The other three ThemeKey axes — a look's chromaScale/lightnessScale/
// lightnessShift, transposed through the same transposedPalette as hueShift
// (brandon-themes-07p). Asserted in OKLCH terms (Oklch.fromRgba) so "the
// saturation moved" is a checked number, not an inference from a differing hex.
// ────────────────────────────────────────────────────────────────────────────

describe("non-hue ThemeKey axes via palette transposition", () => {
  const base = makeTestPalette();
  const key = (overrides: Partial<ThemeKey>): ThemeKey => ({
    hueShift: 0,
    chromaScale: 1,
    lightnessScale: 1,
    lightnessShift: 0,
    ...overrides,
  });

  test("chromaScale 0.5 desaturates a non-anchored color (chroma drops, hue holds)", () => {
    const shifted = transposedPalette(base, key({ chromaScale: 0.5 }));
    const a = Oklch.fromRgba(base.get("primary")!);
    const b = Oklch.fromRgba(shifted.get("primary")!);
    expect(b.c).toBeLessThan(a.c * 0.75);
    expect(Math.abs(b.h - a.h)).toBeLessThanOrEqual(2);
  });

  test("lightnessScale -1 (INVERT_LIGHTNESS) flips lightness toward its complement", () => {
    const shifted = transposedPalette(
      base,
      key({ lightnessScale: -1, lightnessShift: 1 }),
    );
    const a = Oklch.fromRgba(base.get("primary")!);
    const b = Oklch.fromRgba(shifted.get("primary")!);
    // L' = 1 - L: the inverted lightness lands near the complement, not near the original.
    expect(Math.abs(b.l - (1 - a.l))).toBeLessThan(0.05);
    expect(Math.abs(b.l - a.l)).toBeGreaterThan(0.1);
  });

  test("memoized: distinct chromaScale/lightnessScale values are distinct cache entries", () => {
    // Guards transposedPalette's cache key — before it covered all four axes,
    // two keys differing only on chroma/lightness would collide and silently
    // share a palette.
    const vivid = transposedPalette(base, key({ chromaScale: 1.5 }));
    const muted = transposedPalette(base, key({ chromaScale: 0.5 }));
    expect(vivid).not.toBe(muted);
    expect(vivid.get("primary")!.red).not.toBe(muted.get("primary")!.red);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 10. paletteForThemeName — the single name -> Palette enforcer (k5a.4)
// ────────────────────────────────────────────────────────────────────────────

describe("paletteForThemeName", () => {
  test("memoized: same name returns the same palette instance", () => {
    expect(paletteForThemeName("nord")).toBe(paletteForThemeName("nord"));
  });

  test("resolves aliases to the same palette as the canonical name", () => {
    // 'dark' is an alias of 'textual-dark' (resolvePaletteName), so both must
    // collapse to one cached palette.
    expect(paletteForThemeName("dark")).toBe(
      paletteForThemeName("textual-dark"),
    );
  });

  test("distinct themes resolve 'primary' to distinct colors", () => {
    const a = paletteForThemeName("nord").get("primary")!;
    const b = paletteForThemeName("gruvbox").get("primary")!;
    expect(maxChannelDelta(a, b)).toBeGreaterThan(5);
  });

  test("an unresolvable name throws loudly (registry drift, not a fallback)", () => {
    expect(() => paletteForThemeName("not-a-real-theme")).toThrow(
      /did not resolve in the theme registry/,
    );
  });
});
