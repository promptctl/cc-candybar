// [LAW:single-enforcer] Pinned against the render spine — single-line is the degenerate one-child case, not a separate path.
// [LAW:behavior-not-structure] Only observable output: line count, which segment lands where, the separator, link survival.

import { SessionState } from "../src/daemon/session-state";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { ConfigError } from "../src/config/dsl-loader";

const ALLOWED_PALETTES = new Set(["textual-dark"]);

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

function basePalette() {
  return getThemePalette("textual-dark"!);
}

function buildRuntime(source: string) {
  const config = parseAndValidate("<test>", source, ALLOWED_PALETTES);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  return { config, compiled, store, registry };
}

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
    expect(lines[0]!.indexOf("A")).toBeLessThan(lines[0]!.indexOf("B"));
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
    // [LAW:no-silent-failure] `layout:` was removed; the loader must surface the migration error.
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
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toContain("B");
    expect(lines[0]!).not.toContain("A");
    expect(lines[1]!).toContain("C");
  });

  test("authored \\n inside a single segment splits its cell into multiple lines", () => {
    // The newline rides inside ONE segment's cell stream, so the cell-stream split partitions it BEFORE the strip measures.
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
    expect(lines[0]!).not.toContain("\n");
  });

  test("fixed-width segment with authored \\n caps each line independently", () => {
    // Regression: the split must happen BEFORE per-segment width layout, or the merged cell measures over-width and truncates the second line away.
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
    expect(out).not.toContain("…");
  });

  test("OSC-8 link survives an authored \\n split (both pieces keep the URL)", () => {
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
    for (const line of lines) {
      expect(line).toContain("cc-candybar://x/1");
    }
  });

  test("A-grammar v-arm with two children stacks them as two lines", () => {
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
    // [LAW:behavior-not-structure] `horizontal` composes CELLS, not serialized blocks, so the joiner caps across the seam; abut would produce different bytes.
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
    // Row 0 carries both children's cells, row 1 only the taller child's. No rectangle padding.
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
    // A false container contributes no lines; its descendants are still walked.
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
