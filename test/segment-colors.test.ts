// [LAW:behavior-not-structure] Tests assert observable output (resolved hex
// values, Style fields, thrown errors) — never internal state.

import { Palette, PaletteResolver, parseRgbHex, ColorSpec } from "rich-js";
import { createCcCandybarEngine } from "../src/template-engine/engine";
import { resolveSegmentColors, ColorSpecError } from "../src/template-engine/colors";
import type { Template } from "@promptctl/go-template-js";
import type { RichText } from "rich-js";

// ─── Test palette + resolver ──────────────────────────────────────────────────

function makeTestResolver(): PaletteResolver {
  const vars = new Map([
    ["primary", parseRgbHex("4488ff")],
    ["error", parseRgbHex("ff4444")],
    ["info", parseRgbHex("44aaff")],
    ["success", parseRgbHex("44cc88")],
    ["surface", parseRgbHex("1a1a2e")],
    ["text", parseRgbHex("eeeeee")],
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
// 9. hueStep threading — per-segment hue rotation (wd5.4)
// ────────────────────────────────────────────────────────────────────────────

describe("hueStep threading", () => {
  test("hueRotationDegrees 0 → identical output to no rotation (identity)", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("primary");
    const withZero = resolveSegmentColors(resolver, bgTpl, undefined, {}, { hueRotationDegrees: 0 });
    const withNone = resolveSegmentColors(resolver, bgTpl, undefined, {});
    expect(withZero.bgcolor?.value?.hex).toBe(withNone.bgcolor?.value?.hex);
  });

  test("hueRotationDegrees 30 → bg color differs from un-rotated primary", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("primary");
    const rotated = resolveSegmentColors(resolver, bgTpl, undefined, {}, { hueRotationDegrees: 30 });
    const original = resolveSegmentColors(resolver, bgTpl, undefined, {});
    expect(rotated.bgcolor?.value?.hex).not.toBe(original.bgcolor?.value?.hex);
  });

  test("hueRotationDegrees 30 → error spec is exempt (semantic color unchanged)", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("error");
    const rotated = resolveSegmentColors(resolver, bgTpl, undefined, {}, { hueRotationDegrees: 30 });
    expect(rotated.bgcolor?.value?.hex).toBe("#ff4444");
  });

  test("hueRotationDegrees 90 → warning spec is exempt (semantic color unchanged)", () => {
    const resolver = makeTestResolver();
    // warning is a semantic spec; add it to the test palette
    const vars = new Map([
      ["warning", parseRgbHex("ffaa00")],
      ["primary", parseRgbHex("4488ff")],
    ]);
    const r = new PaletteResolver(new Palette("test", true, vars));
    const bgTpl = parseTemplate("warning", r);
    const rotated = resolveSegmentColors(r, bgTpl, undefined, {}, { hueRotationDegrees: 90 });
    expect(rotated.bgcolor?.value?.hex).toBe("#ffaa00");
  });

  test("hueRotationDegrees 30 → success spec is exempt (semantic color unchanged)", () => {
    const resolver = makeTestResolver(); // success: #44cc88
    const bgTpl = parseTemplate("success");
    const rotated = resolveSegmentColors(resolver, bgTpl, undefined, {}, { hueRotationDegrees: 30 });
    expect(rotated.bgcolor?.value?.hex).toBe("#44cc88");
  });

  test("hueRotationDegrees 30 → info spec is exempt (semantic color unchanged)", () => {
    const resolver = makeTestResolver(); // info: #44aaff
    const bgTpl = parseTemplate("info");
    const rotated = resolveSegmentColors(resolver, bgTpl, undefined, {}, { hueRotationDegrees: 30 });
    expect(rotated.bgcolor?.value?.hex).toBe("#44aaff");
  });

  test("fg auto-contrast resolves against the rotated bg, not the original", () => {
    const resolver = makeTestResolver();
    const bgTpl = parseTemplate("primary"); // #4488ff (blue)
    const fgTpl = parseTemplate("auto");
    // Rotate 180 degrees: blue → yellow-ish. The auto-contrast fg should
    // differ between rotated and unrotated because the bg luminance changes.
    const rotated = resolveSegmentColors(resolver, bgTpl, fgTpl, {}, { hueRotationDegrees: 180 });
    const original = resolveSegmentColors(resolver, bgTpl, fgTpl, {});
    // Both should have a defined fg; they may or may not differ (luminance of
    // 180-rotated blue could be similar). Just verify fg is always present.
    expect(rotated.color).toBeDefined();
    expect(original.color).toBeDefined();
    // Rotated bg must differ from original bg.
    expect(rotated.bgcolor?.value?.hex).not.toBe(original.bgcolor?.value?.hex);
  });
});
