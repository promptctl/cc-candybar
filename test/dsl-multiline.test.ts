// [LAW:single-enforcer] These tests pin the multi-line layout contract
// directly against the render spine. renderDsl walks the canonical node tree
// (renderNode); a vertical container stacks its children's rendered lines with
// exactly one `\n` between them. Single-line is the degenerate one-child case —
// not a separate code path. They also pin the two vertical-line sources: an
// AUTHORED "\n" inside a segment's cell stream (split-before-layout) and the
// raw `root` node grammar authored via the A-grammar (seg/h/v).
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
  colorCompatibility: "truecolor" as const, wrap: true,
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
      root: 's',
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
      root: { v: ['top', 'bot'] },
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
      root: { v: [{ h: ['sa', 'sb'] }, { h: ['sc', 'sd'] }] },
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

  test("empty root container produces empty string (no newlines, no segments)", () => {
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: {},
      segments: {},
      root: { v: [] },
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    expect(out).toBe("");
  });

  test("layout: key is rejected with migration error (removed in 2de.19)", () => {
    // [LAW:no-silent-failure] `layout:` was removed; the loader must surface the
    // migration error so users know exactly how to rewrite their config.
    const source = `{
      segments: { s: { template: ' x ', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
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
      root: { v: [{ h: ['sa', 'sb'] }, 'sc'] },
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
      root: 's',
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

  test("fixed-width segment with authored \\n caps each line independently", () => {
    // Regression: the split must happen BEFORE per-segment width layout. With
    // split-after-layout, the merged 'ABCDE\nFGHIJ' cell measures as one
    // over-width cell and truncates — destroying the second line. Split-first
    // lays out each 5-wide line cleanly, so both survive intact.
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: { x: { kind: 'literal', value: 'ABCDE\\nFGHIJ' } },
      segments: { s: { template: '{{ .x }}', width: 5, bg: 'surface', fg: 'foreground' } },
      root: 's',
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toContain("ABCDE");
    expect(lines[1]!).toContain("FGHIJ");
    // The second line is not truncated away, and no truncation marker appears.
    expect(out).not.toContain("…");
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
      root: 's',
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

  test("A-grammar v-arm with two children stacks them as two lines", () => {
    // Direct test of the canonical v-arm spelling replacing the old `cells` leaf form.
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
      root: { v: ['top', 'bot'] },
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toContain("TOP");
    expect(lines[1]!).toContain("BOT");
  });

  test("horizontal container of single-line leaves is byte-identical to h-arm (caps across the seam — no abut)", () => {
    // [LAW:behavior-not-structure] The defining contract of `horizontal`: it
    // composes CELLS (not serialized blocks), so the joiner caps across the
    // seam exactly as if the segments lived in one node. Abut would serialize
    // each child first and string-concat — producing a triangle-into-void seam
    // and DIFFERENT bytes. Byte-equality is the precise refutation of abut.
    const segs = `
      segments: {
        sa: { template: ' {{ .a }} ', bg: 'surface', fg: 'foreground' },
        sb: { template: ' {{ .b }} ', bg: 'surface', fg: 'foreground' },
      },`;
    const vars = `
      variables: {
        a: { kind: 'literal', value: 'AA' },
        b: { kind: 'literal', value: 'BB' },
      },`;
    const hArmSrc = `{ globals: { palette: 'textual-dark' },${vars}${segs}
      root: { h: ['sa', 'sb'] } }`;
    const horizSrc = `{ globals: { palette: 'textual-dark' },${vars}${segs}
      root: { kind: 'container', direction: 'horizontal', children: ['sa', 'sb'] } }`;
    const hArm = buildRuntime(hArmSrc);
    const horiz = buildRuntime(horizSrc);
    const hArmOut = renderDsl(hArm.config, hArm.compiled, hArm.store, hArm.registry, {}, basePalette(), OPTS);
    const horizOut = renderDsl(horiz.config, horiz.compiled, horiz.store, horiz.registry, {}, basePalette(), OPTS);
    expect(horizOut).toBe(hArmOut);
    expect(horizOut.split("\n")).toHaveLength(1);
  });

  test("horizontal container of multi-line children zips cells per row (ragged rows carry fewer cells, no padding)", () => {
    // colL is 2 lines, colR is 1 — row 0 carries both children's cells (joined
    // in one strip), row 1 carries only the taller child's. No rectangle padding.
    const source = `{
      globals: { palette: 'textual-dark' },
      variables: {
        l1: { kind: 'literal', value: 'L1' }, l2: { kind: 'literal', value: 'L2' },
        r1: { kind: 'literal', value: 'R1' },
      },
      segments: {
        sl1: { template: ' {{ .l1 }} ', bg: 'surface', fg: 'foreground' },
        sl2: { template: ' {{ .l2 }} ', bg: 'surface', fg: 'foreground' },
        sr1: { template: ' {{ .r1 }} ', bg: 'surface', fg: 'foreground' },
      },
      root: {
        kind: 'container',
        direction: 'horizontal',
        children: [
          { v: ['sl1', 'sl2'] },
          { v: ['sr1'] },
        ],
      },
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toContain("L1");
    expect(lines[0]!).toContain("R1");
    expect(lines[1]!).toContain("L2");
    expect(lines[1]!).not.toContain("R1");
  });

  test("a container's `when` gates its whole subtree (hidden → no line)", () => {
    // A false container contributes no lines; its descendants are still walked
    // (hue stability) but emit nothing.
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
      root: { v: [
        { v: ['sa'], when: '{{ ne .show "" }}' },
        'sb',
      ] },
    }`;
    const { config, compiled, store, registry } = buildRuntime(source);
    const out = renderDsl(config, compiled, store, registry, {}, basePalette(), OPTS);
    const lines = out.split("\n").map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toContain("B");
    expect(lines[0]!).not.toContain("A");
  });
});
