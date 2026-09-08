// [LAW:behavior-not-structure] Assertions are on observable output. The ordered phase
// sequence is what makes `{{ bgOf }}` readable in a `fg:` template and an error in `bg:`.

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
import { TERMINAL_TEXT, type Disclosure, type TextFloor } from "../src/themes/decor";
import {
  transposedPalette,
  paletteForThemeName,
} from "../src/themes/palette-resolvers";
import type { Template } from "@promptctl/go-template-js";
import type { RichText, Style, ThemeKey } from "@promptctl/rich-js";

function makeTestPalette(name = "test", primaryHex = "4488ff"): Palette {
  const vars = new Map<string, ColorRgba>([
    ["primary", parseRgbHex(primaryHex)],
    ["error", parseRgbHex("ff4444")],
    ["info", parseRgbHex("44aaff")],
    ["success", parseRgbHex("44cc88")],
    ["surface", parseRgbHex("1a1a2e")],
    ["text", parseRgbHex("eeeeee")],
    // transposePalette derives the dark flag from "background".
    ["background", parseRgbHex("12121a")],
  ]);
  return new Palette(name, true, vars);
}


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
  text: TextFloor = TERMINAL_TEXT,
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

const DISCLOSURE: Disclosure = { hue: "primary", depth: 0 };
// A colour no palette role here spells, so a background equal to it came from the floor.
const TINT = parseRgbHex("102030");
// The text IS the background it was asked about, so assertions see which one the floor got.
const TEXT_IS_BG: TextFloor = (background) => background;


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

  test("undefined fg → the region's floor, chosen on the tint when no bg is authored", () => {
    const style = resolve(
      makeHarness(),
      makeTestPalette(),
      undefined,
      undefined,
      {},
      TEXT_IS_BG,
    );
    expect(style.color?.value?.hex).toBe(TINT.hex);
  });

  test("undefined fg → the floor chosen on the AUTHORED bg, never the tint it painted over", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), h.parse("error"), undefined, {}, TEXT_IS_BG);
    expect(style.color?.value?.hex).toBe("#ff4444");
  });

  test("an authored fg paints over the region's floor", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), undefined, h.parse("error"), {}, TEXT_IS_BG);
    expect(style.color?.value?.hex).toBe("#ff4444");
  });

  test("{{ bgOf }} in a fg template reads the tint when no bg is authored", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), undefined, h.parse("{{ bgOf }}"));
    expect(style.color?.value?.hex).toBe(TINT.hex);
  });
});


describe("bg/fg color references", () => {
  test("bare name resolves to the palette color", () => {
    const h = makeHarness();
    const style = resolve(h, makeTestPalette(), h.parse("error"), undefined);
    expect(style.isNull).toBe(false);
    expect(style.bgcolor?.value?.hex).toBe("#ff4444");
  });

  test("a computed color reference resolves through the same path as a name", () => {
    // The name-authored and computed forms are one code path (resolveColorRef is idempotent).
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


describe("phase ordering — palette, then bg, then fg", () => {
  test("the palette is live inside the bg phase ({{ color }} resolves there)", () => {
    // Phase 0 publishes the palette BEFORE the bg template runs.
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
    // A fresh ref is never published into: what a variable or a node `when` evaluates in.
    const h = makeHarness();
    expect(h.ref.current).toBeNull();
    expect(() => h.parse("{{ bgOf }}").evaluate({})).toThrow(
      /no active segment/,
    );
    expect(() => h.parse('{{ color "primary" }}').evaluate({})).toThrow(
      /no active segment/,
    );
    expect(() =>
      h.parse('{{ ramp 50 "step" 0 "primary" 100 "error" }}').evaluate({}),
    ).toThrow(/\{\{ ramp \}\}.*no active segment/);
  });

  test("the published palette is the one passed in, not one captured at parse", () => {
    // Two clocks closed: ONE parsed template, two palettes, two answers.
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


describe("fg computed from bgOf", () => {
  test("contrastOn (bgOf) over a dark bg resolves to a light color", () => {
    const h = makeHarness();
    const palette = makeTestPalette();
    const style = resolve(
      h,
      palette,
      h.parse("surface"),
      h.parse("{{ contrastOn (bgOf) }}"),
    );
    expect(style.color?.value?.hex).toBe(
      contrastFor(palette.get("surface")!).hex,
    );
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
    const engine = createCcCandybarEngine();
    const tpl = engine.parse('{{ color "primary" }}');
    expect(() => tpl.evaluate({})).toThrow(/"color" is not registered/);
  });

  test("an engine built without segmentColorFuncs has no `bgOf` function", () => {
    const engine = createCcCandybarEngine();
    const tpl = engine.parse("{{ bgOf }}");
    expect(() => tpl.evaluate({})).toThrow(/"bgOf" is not registered/);
  });
});


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

// [LAW:behavior-not-structure] Hue is a property of the palette handed in, not an option
// of resolveSegmentColors; the anchor rule itself is owned and tested in rich-js.

// sRGB↔OKLCH round-trips quantize by ±1.
function maxChannelDelta(a: ColorRgba, b: ColorRgba): number {
  return Math.max(
    Math.abs(a.red - b.red),
    Math.abs(a.green - b.green),
    Math.abs(a.blue - b.blue),
  );
}

describe("per-segment hue via palette transposition", () => {
  const base = makeTestPalette();
  // A hue-only ThemeKey — the other three axes identity.
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
    // error/success are hue-locked under transpose, so they survive while primary moves.
    expect(
      maxChannelDelta(shifted.get("error")!, base.get("error")!),
    ).toBeLessThanOrEqual(2);
    expect(
      maxChannelDelta(shifted.get("success")!, base.get("success")!),
    ).toBeLessThanOrEqual(2);
  });

  test("hueShift 30 → 'info' is NOT anchored (transposes like any color)", () => {
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
    // Transposing the whole palette shifts a LITERAL fg alongside bg.
    const h = makeHarness();
    const shifted = transposedPalette(base, hueKey(60));
    const bgTpl = h.parse("surface");
    const fgTpl = h.parse("info");
    const style = resolve(h, shifted, bgTpl, fgTpl);
    const baseStyle = resolve(h, base, bgTpl, fgTpl);
    expect(style.color?.value?.hex).not.toBe(baseStyle.color?.value?.hex);
  });
});

// The non-hue ThemeKey axes, asserted in OKLCH terms so "the saturation moved" is a number.

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
    // L' = 1 - L lands near the complement, not near the original.
    expect(Math.abs(b.l - (1 - a.l))).toBeLessThan(0.05);
    expect(Math.abs(b.l - a.l)).toBeGreaterThan(0.1);
  });

  test("memoized: distinct chromaScale/lightnessScale values are distinct cache entries", () => {
    // Guards transposedPalette's cache key over all four axes.
    const vivid = transposedPalette(base, key({ chromaScale: 1.5 }));
    const muted = transposedPalette(base, key({ chromaScale: 0.5 }));
    expect(vivid).not.toBe(muted);
    expect(vivid.get("primary")!.red).not.toBe(muted.get("primary")!.red);
  });
});


describe("paletteForThemeName", () => {
  test("memoized: same name returns the same palette instance", () => {
    expect(paletteForThemeName("nord")).toBe(paletteForThemeName("nord"));
  });

  test("resolves aliases to the same palette as the canonical name", () => {
    // 'dark' is an alias of 'textual-dark', so both must collapse to one cached palette.
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
