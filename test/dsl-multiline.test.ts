// [LAW:single-enforcer] These tests pin the multi-line layout contract
// directly against the render spine. renderDsl walks `config.layout` as a 2D
// array of rows; each row renders through the same per-segment pipeline as a
// single-row config; rows are joined with exactly one `\n`. Single-line is
// the degenerate `[[...]]` case — not a separate code path.
//
// [LAW:behavior-not-structure] Assertions pin observable output: line count,
// segment-rendered-into-correct-line, exact newline separator. Internal
// refactors (hue rotation policy, sink ordering) that preserve these
// behaviors must not break these tests.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { ConfigError } from "../src/config/dsl-loader";

const ALLOWED_PALETTES = new Set(["textual-dark"]);

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  width: Number.POSITIVE_INFINITY,
};

function basePalette() {
  return new PaletteResolver(getThemePalette("textual-dark")!);
}

function buildRuntime(source: string) {
  const config = parseAndValidate("<test>", source, ALLOWED_PALETTES);
  const store = new VariableStore();
  const registry = new SourceRegistry(store);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  return { config, compiled, store, registry };
}

// Strip ANSI for line-shape assertions. Color codes and OSC-8 links live in
// rendered output but obscure the row-count / row-content checks we want here.
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("renderDsl — multi-line layout", () => {
  test("single-row layout produces exactly one line (no trailing newline)", () => {
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: { x: { kind: 'literal', value: 'A' } },
      segments: { s: { template: ' {{ .x }} ', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    expect(out.includes("\n")).toBe(false);
    expect(stripAnsi(out)).toContain("A");
  });

  test("two-row layout produces two lines separated by exactly one newline", () => {
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: {
        a: { kind: 'literal', value: 'TOP' },
        b: { kind: 'literal', value: 'BOT' },
      },
      segments: {
        top: { template: ' {{ .a }} ', bg: 'surface', fg: 'foreground' },
        bot: { template: ' {{ .b }} ', bg: 'surface', fg: 'foreground' },
      },
      layout: [['top'], ['bot']],
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0]!)).toContain("TOP");
    expect(stripAnsi(lines[1]!)).toContain("BOT");
    // No segment cross-contamination.
    expect(stripAnsi(lines[0]!)).not.toContain("BOT");
    expect(stripAnsi(lines[1]!)).not.toContain("TOP");
  });

  test("row segments render in column order; rows render in row order", () => {
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: {
        a: { kind: 'literal', value: 'A' },
        b: { kind: 'literal', value: 'B' },
        c: { kind: 'literal', value: 'C' },
        d: { kind: 'literal', value: 'D' },
      },
      segments: {
        sa: { template: '{{ .a }}', bg: 'surface', fg: 'foreground' },
        sb: { template: '{{ .b }}', bg: 'surface', fg: 'foreground' },
        sc: { template: '{{ .c }}', bg: 'surface', fg: 'foreground' },
        sd: { template: '{{ .d }}', bg: 'surface', fg: 'foreground' },
      },
      layout: [['sa', 'sb'], ['sc', 'sd']],
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    expect(lines).toHaveLength(2);
    // Row 0: A precedes B
    expect(lines[0]!.indexOf("A")).toBeLessThan(lines[0]!.indexOf("B"));
    // Row 1: C precedes D
    expect(lines[1]!.indexOf("C")).toBeLessThan(lines[1]!.indexOf("D"));
  });

  test("empty layout produces empty string (no newlines, no segments)", () => {
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: {},
      segments: {},
      layout: [],
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    expect(out).toBe("");
  });

  test("legacy flat string[] layout rejected at parse time", () => {
    // [LAW:no-silent-fallbacks] Migration path is "wrap your list in []".
    // The loader must reject the old shape so users see the breaking change.
    const source = `{
      segments: { s: { template: ' x ', bg: 'surface', fg: 'foreground' } },
      layout: ['s'],
    }`;
    expect(() =>
      parseAndValidate("<test>", source, ALLOWED_PALETTES),
    ).toThrow(ConfigError);
  });

  test("hidden-by-when segments are skipped but row structure preserved", () => {
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: {
        showA: { kind: 'literal', value: '' },
        b: { kind: 'literal', value: 'B' },
        c: { kind: 'literal', value: 'C' },
      },
      segments: {
        sa: {
          template: ' A ',
          bg: 'surface', fg: 'foreground',
          when: '{{ ne .showA "" }}',
        },
        sb: { template: ' {{ .b }} ', bg: 'surface', fg: 'foreground' },
        sc: { template: ' {{ .c }} ', bg: 'surface', fg: 'foreground' },
      },
      layout: [['sa', 'sb'], ['sc']],
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    // Row 0 still emits even though `sa` hid — it just contains only B.
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toContain("B");
    expect(lines[0]!).not.toContain("A");
    expect(lines[1]!).toContain("C");
  });
});
