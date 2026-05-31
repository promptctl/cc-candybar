// [LAW:single-enforcer] These tests pin the multi-line layout contract
// directly against the render spine. renderDsl walks the canonical node tree
// (renderNode); the flat `layout` sugar compiles to one vertical container of
// cells leaves; leaves are joined with exactly one `\n`. Single-line is the
// degenerate one-leaf case — not a separate code path. They also pin the two
// vertical-line sources that feed the same join: an AUTHORED "\n" inside a
// segment's cell stream (split on the cells, span-preserving) and the raw
// `root` node grammar authored directly.
//
// [LAW:behavior-not-structure] Assertions pin observable output: line count,
// segment-rendered-into-correct-line, exact newline separator, link survival.
// Internal refactors (hue rotation policy, sink ordering) that preserve these
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

  test("authored \\n inside a single segment splits its cell into multiple lines", () => {
    // The "\n" rides inside ONE segment's rendered cell stream — the cell-stream
    // split (not output-split) partitions it BEFORE the strip measures, so each
    // side is its own independently-rendered line. This is the case PR #58's
    // output-split could catch only by accident; here it is first-class.
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: { x: { kind: 'literal', value: 'TOP\\nBOT' } },
      segments: { s: { template: '{{ .x }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toContain("TOP");
    expect(lines[0]!).not.toContain("BOT");
    expect(lines[1]!).toContain("BOT");
    expect(lines[1]!).not.toContain("TOP");
    // The "\n" is consumed as the partition point — it never leaks into a line.
    expect(lines[0]!).not.toContain("\n");
  });

  test("OSC-8 link survives an authored \\n split (both pieces keep the URL)", () => {
    // A linked fragment carrying a "\n" splits into two lines; the OSC-8 hyperlink
    // span must be preserved on each piece, not dropped at the boundary.
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: { x: { kind: 'literal', value: 'UP\\nDN' } },
      segments: {
        s: {
          template: '{{ link "cc-candybar://x/1" .x }}',
          bg: 'surface', fg: 'foreground',
        },
      },
      layout: [['s']],
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    // Each visual line carries an OSC-8 open sequence for the same URL.
    for (const line of lines) {
      expect(line).toContain("cc-candybar://x/1");
    }
  });

  test("raw root grammar: a cells leaf inside a vertical container renders", () => {
    // The substrate's own authoring surface — no `layout` sugar. A vertical
    // container of two cells leaves stacks them, identical to two sugar rows.
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
      root: {
        kind: 'container',
        direction: 'vertical',
        children: [
          { kind: 'cells', segments: ['top'] },
          { kind: 'cells', segments: ['bot'] },
        ],
      },
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toContain("TOP");
    expect(lines[1]!).toContain("BOT");
  });

  test("a container's `when` gates its whole subtree (hidden → no line)", () => {
    // A false container contributes no lines; its descendants are still walked
    // (hue stability) but emit nothing — the same contract a hidden row had.
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: {
        show: { kind: 'literal', value: '' },
        a: { kind: 'literal', value: 'A' },
        b: { kind: 'literal', value: 'B' },
      },
      segments: {
        sa: { template: ' {{ .a }} ', bg: 'surface', fg: 'foreground' },
        sb: { template: ' {{ .b }} ', bg: 'surface', fg: 'foreground' },
      },
      root: {
        kind: 'container',
        direction: 'vertical',
        children: [
          { kind: 'container', direction: 'vertical', when: '{{ ne .show "" }}',
            children: [ { kind: 'cells', segments: ['sa'] } ] },
          { kind: 'cells', segments: ['sb'] },
        ],
      },
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toContain("B");
    expect(lines[0]!).not.toContain("A");
  });

  test("authoring both `layout` and `root` is rejected", () => {
    // [LAW:one-source-of-truth] Two authoring surfaces for the same tree could
    // diverge — the loader rejects the ambiguity loudly.
    const source = `{
      segments: { s: { template: ' x ', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
      root: { kind: 'cells', segments: ['s'] },
    }`;
    expect(() =>
      parseAndValidate("<test>", source, ALLOWED_PALETTES),
    ).toThrow(ConfigError);
  });
});
