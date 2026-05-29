// [LAW:behavior-not-structure] Tests assert observable output (resolved hex
// values, Style fields, thrown errors) — never internal state.

import { Palette, PaletteResolver, parseRgbHex, ColorSpec, ColorRgba } from "@promptctl/rich-js";
import { createCcCandybarEngine } from "../src/template-engine/engine";
import { resolveSegmentColors, ColorSpecError } from "../src/template-engine/colors";
import {
  transposedResolver,
  resolverForThemeName,
} from "../src/themes/palette-resolvers";
import type { Template } from "@promptctl/go-template-js";
import type { RichText } from "@promptctl/rich-js";

// ─── Test palette + resolver ──────────────────────────────────────────────────

function makeTestResolver(): PaletteResolver {
  const vars = new Map([
    ["primary", parseRgbHex("4488ff")],
    ["error", parseRgbHex("ff4444")],
    ["info", parseRgbHex("44aaff")],
    ["success", parseRgbHex("44cc88")],
    ["surface", parseRgbHex("1a1a2e")],
    ["text", parseRgbHex("eeeeee")],
    // transposePalette derives the dark flag from "background" (required for
    // any non-identity key); real registry palettes always carry it.
    ["background", parseRgbHex("12121a")],
  ]);
  return new PaletteResolver(new Palette("test", true, vars));
}

// Parse a template using a resolver-aware engine (same instance as production).
function parseTemplate(source: string, resolver?: PaletteResolver): Template<RichText> {
  return createCcCandybarEngine(resolver).parse(source);
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Both templates absent → null Style (no color override)
// ────────────────────────────────────────────────────────────────────────────

describe("no bg/fg templates → null Style", () => {
  test("undefined bg and fg → Style.isNull", () => {
    const resolver = makeTestResolver();
    const style = resolveSegmentColors(resolver, undefined, undefined, {});
    expect(style.isNull).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Static bg (degenerate template — same code path as a conditional)
// ────────────────────────────────────────────────────────────────────────────

describe("static bg spec (no template interpolation)", () => {
  test("bare name resolves to the palette color", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("error");
    const style = resolveSegmentColors(resolver, bgTpl, undefined, {});
    expect(style.isNull).toBe(false);
    expect(style.bgcolor?.value?.hex).toBe("#ff4444");
  });

  test("modifier syntax works through the same code path", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("primary-darken-1");
    const style = resolveSegmentColors(resolver, bgTpl, undefined, {});
    expect(style.isNull).toBe(false);
    // darken-1 must differ from base primary color
    expect(style.bgcolor?.value?.hex).not.toBe("#4488ff");
  });

  test("static fg resolves without bg context", () => {
    const resolver = makeTestResolver();
    const fgTpl = parseTemplate("text");
    const style = resolveSegmentColors(resolver, undefined, fgTpl, {});
    expect(style.color?.value?.hex).toBe("#eeeeee");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. bg template with conditional — different specs based on variable state
// ────────────────────────────────────────────────────────────────────────────

describe("conditional bg template", () => {
  const resolver = makeTestResolver();
  const bgTpl = parseTemplate(
    '{{ if gt .percent 90.0 }}error{{ else if gt .percent 75.0 }}info{{ else }}success{{ end }}'
  );

  test("percent > 90 → error color", () => {
    const style = resolveSegmentColors(resolver, bgTpl, undefined, { percent: 95 });
    expect(style.bgcolor?.value?.hex).toBe("#ff4444");
  });

  test("percent 76–90 → info color", () => {
    const style = resolveSegmentColors(resolver, bgTpl, undefined, { percent: 80 });
    expect(style.bgcolor?.value?.hex).toBe("#44aaff");
  });

  test("percent ≤ 75 → success color", () => {
    const style = resolveSegmentColors(resolver, bgTpl, undefined, { percent: 50 });
    expect(style.bgcolor?.value?.hex).toBe("#44cc88");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. fg = 'auto' resolves against the segment's resolved bg
// ────────────────────────────────────────────────────────────────────────────

describe("auto-contrast fg resolution", () => {
  test("auto fg against dark bg resolves to a light color", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("surface"); // dark: #1a1a2e
    const fgTpl = parseTemplate("auto");
    const style = resolveSegmentColors(resolver, bgTpl, fgTpl, {});
    // auto against a dark background should produce a light (high-value) color
    const hex = style.color?.value?.hex;
    expect(hex).toBeDefined();
    const r = parseInt(hex!.slice(1, 3), 16);
    const g = parseInt(hex!.slice(3, 5), 16);
    const b = parseInt(hex!.slice(5, 7), 16);
    const luminance = (r + g + b) / 3;
    expect(luminance).toBeGreaterThan(128); // light result on dark bg
  });

  test("auto fg without bg throws ColorSpecError (missing context)", () => {
    const resolver = makeTestResolver();
    const fgTpl = parseTemplate("auto");
    expect(() => resolveSegmentColors(resolver, undefined, fgTpl, {})).toThrow(ColorSpecError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Alpha specs require bg context
// ────────────────────────────────────────────────────────────────────────────

describe("alpha spec needs bg context", () => {
  test("'primary 50%' without bg throws ColorSpecError", () => {
    const resolver = makeTestResolver();
    const fgTpl = parseTemplate("primary 50%");
    expect(() => resolveSegmentColors(resolver, undefined, fgTpl, {})).toThrow(ColorSpecError);
  });

  test("'primary 50%' with bg resolves to a blended color", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("surface");
    const fgTpl = parseTemplate("primary 50%");
    const style = resolveSegmentColors(resolver, bgTpl, fgTpl, {});
    expect(style.isNull).toBe(false);
    expect(style.color?.value?.hex).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Invalid color spec surfaces clear error at render time
// ────────────────────────────────────────────────────────────────────────────

describe("invalid color spec → ColorSpecError", () => {
  test("unknown bg spec name throws ColorSpecError", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("nonexistent-color");
    expect(() => resolveSegmentColors(resolver, bgTpl, undefined, {})).toThrow(ColorSpecError);
  });

  test("unknown fg spec name throws ColorSpecError", () => {
    const resolver = makeTestResolver();
    const fgTpl = parseTemplate("totally-bogus");
    expect(() => resolveSegmentColors(resolver, undefined, fgTpl, {})).toThrow(ColorSpecError);
  });

  test("error message names the spec and role", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("not-a-real-color");
    let caught: unknown;
    try {
      resolveSegmentColors(resolver, bgTpl, undefined, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ColorSpecError);
    expect((caught as ColorSpecError).message).toContain("not-a-real-color");
    expect((caught as ColorSpecError).message).toContain("bg");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Palette functions registered in engine when resolver provided
// ────────────────────────────────────────────────────────────────────────────

describe("palette functions in engine", () => {
  test("{{ primary ... }} style function available when resolver provided", () => {
    const resolver = makeTestResolver();
    const engine = createCcCandybarEngine(resolver);
    const tpl = engine.parse('{{ primary "hello" }}');
    const fragments = tpl.evaluate({});
    // The fragment should have a color from the 'primary' palette entry
    const style = fragments[0]?.style;
    expect(style?.color?.value?.hex).toBe("#4488ff");
  });

  test("engine without resolver does not have palette functions", () => {
    const engine = createCcCandybarEngine(); // no resolver
    const tpl = engine.parse('{{ primary "hello" }}');
    expect(() => tpl.evaluate({})).toThrow(); // FuncNotFoundError or similar
  });

  test("palette function in template: field — full render", () => {
    const resolver = makeTestResolver();
    const engine = createCcCandybarEngine(resolver);
    const tpl = engine.parse('{{ error "critical" }}');
    const fragments = tpl.evaluate({});
    expect(fragments[0]?.style?.color?.value?.hex).toBe("#ff4444");
    expect(fragments[0]?.plain).toBe("critical");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. Both bg and fg resolved — Style carries both colors
// ────────────────────────────────────────────────────────────────────────────

describe("both bg and fg resolved", () => {
  test("Style has both bgcolor and color set", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("surface");
    const fgTpl = parseTemplate("text");
    const style = resolveSegmentColors(resolver, bgTpl, fgTpl, {});
    expect(style.bgcolor?.value?.hex).toBe("#1a1a2e");
    expect(style.color?.value?.hex).toBe("#eeeeee");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 9. Per-segment hue = WHICH palette (whole-theme transposition)
//
// [LAW:behavior-not-structure] The hue behavior is now a property of the palette
// the resolver carries, not an option of resolveSegmentColors. These assert the
// observable: resolved hex through a transposed resolver. The anchor rule itself
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
  const base = makeTestResolver();

  test("hueShift 0 → identity: resolved color is byte-exact to base", () => {
    const shifted = transposedResolver(base, 0);
    const a = shifted.resolve("primary")!;
    const b = base.resolve("primary")!;
    expect(maxChannelDelta(a, b)).toBe(0);
  });

  test("hueShift 30 → non-anchored color shifts substantially", () => {
    const shifted = transposedResolver(base, 30);
    const a = shifted.resolve("primary")!;
    const b = base.resolve("primary")!;
    expect(maxChannelDelta(a, b)).toBeGreaterThan(5);
  });

  test("hueShift 30 → anchored specs (error/success) keep their hue", () => {
    const shifted = transposedResolver(base, 30);
    // error/success are in rich-js ANCHORED_ROOTS: hue-locked under transpose,
    // so they survive within round-trip tolerance while primary (above) moves.
    expect(maxChannelDelta(shifted.resolve("error")!, base.resolve("error")!)).toBeLessThanOrEqual(2);
    expect(maxChannelDelta(shifted.resolve("success")!, base.resolve("success")!)).toBeLessThanOrEqual(2);
  });

  test("hueShift 30 → 'info' is NOT anchored (transposes like any color)", () => {
    // The old local SEMANTIC_SPECS list exempted 'info'; rich-js ANCHORED_ROOTS
    // does not. This is the drift the reshaping removed.
    const shifted = transposedResolver(base, 30);
    expect(
      maxChannelDelta(shifted.resolve("info")!, base.resolve("info")!),
    ).toBeGreaterThan(5);
  });

  test("memoized: same (palette, hueShift) returns the same resolver instance", () => {
    expect(transposedResolver(base, 30)).toBe(transposedResolver(base, 30));
  });

  test("literal fg is transposed too (bg/fg pair preserved, not output-only)", () => {
    // The key fix: transposing the whole palette means a LITERAL fg token
    // shifts alongside bg. The old output-only bg rotation left a literal fg
    // un-shifted, drifting the theme-designed bg/fg relationship apart.
    const shifted = transposedResolver(base, 60);
    // fg is a chromatic literal token (not `auto`): under whole-palette
    // transposition it shifts with bg; the old bg-output-only rotation left it put.
    const bgTpl = parseTemplate("surface", shifted);
    const fgTpl = parseTemplate("info", shifted);
    const style = resolveSegmentColors(shifted, bgTpl, fgTpl, {});
    const baseStyle = resolveSegmentColors(base, bgTpl, fgTpl, {});
    expect(style.color?.value?.hex).not.toBe(baseStyle.color?.value?.hex);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 10. resolverForThemeName — the single name -> PaletteResolver enforcer (k5a.4)
// ────────────────────────────────────────────────────────────────────────────

describe("resolverForThemeName", () => {
  test("memoized: same name returns the same resolver instance", () => {
    expect(resolverForThemeName("nord")).toBe(resolverForThemeName("nord"));
  });

  test("resolves aliases to the same resolver as the canonical name", () => {
    // 'dark' is an alias of 'textual-dark' (resolvePaletteName), so both must
    // collapse to one cached resolver.
    expect(resolverForThemeName("dark")).toBe(
      resolverForThemeName("textual-dark"),
    );
  });

  test("distinct themes resolve a 'primary' spec to distinct colors", () => {
    const a = resolverForThemeName("nord").resolve("primary")!;
    const b = resolverForThemeName("gruvbox").resolve("primary")!;
    expect(maxChannelDelta(a, b)).toBeGreaterThan(5);
  });

  test("an unresolvable name throws loudly (registry drift, not a fallback)", () => {
    expect(() => resolverForThemeName("not-a-real-theme")).toThrow(
      /did not resolve in the theme registry/,
    );
  });
});
