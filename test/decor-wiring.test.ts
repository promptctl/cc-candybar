// [LAW:behavior-not-structure] Expectations are computed from the model (decorFor over the segment's address), never a captured byte string.

import { getThemePalette } from "@promptctl/rich-js";
import type { RichText, ThemeKey } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import type { CompiledNode } from "../src/dsl/node-registry";
import type { DslConfig } from "../src/config/dsl-types";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { transposedPalette } from "../src/themes/palette-resolvers";
import { PRESET_FLOOR } from "../src/config/presets";
import { decorFor, DISTRIBUTIONS, type Address } from "../src/themes/decor";

const ALLOWED = new Set(listResolvablePaletteNames());
const THEME = "textual-dark";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

function addressOf(root: CompiledNode, name: string): Address {
  const walk = (node: CompiledNode, address: Address): Address | undefined => {
    if (node.kind === "segment") return node.name === name ? address : undefined;
    for (const [index, child] of node.children.entries()) {
      const found = walk(child, [
        ...address,
        { index, count: node.children.length, distribution: node.distribution },
      ]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const found = walk(root, []);
  if (found === undefined) throw new Error(`no segment "${name}" in the tree`);
  return found;
}

function build(src: string, look?: ThemeKey, dflt?: DslConfig) {
  const config = parseAndValidate("<test>", src, ALLOWED, dflt);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry);
  const sink = new Map<string, readonly RichText[]>();
  const render = (payload: object = {}): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: "s1", ...payload },
      getThemePalette(THEME),
      OPTS,
      { perSegmentSink: sink },
      look === undefined ? undefined : { look },
    );
  const root = compiled.roots.get(PRESET_FLOOR)!;
  const bgOf = (name: string): string => {
    const cell = sink.get(name)?.[0];
    if (cell === undefined) throw new Error(`segment "${name}" did not render`);
    return cell.style?.bgcolor?.value?.hex ?? "(no bg)";
  };
  const fgOf = (name: string): string =>
    sink.get(name)![0]!.style?.color?.value?.hex ?? "(no fg)";
  const expectedTint = (name: string): string =>
    decorFor(
      transposedPalette(getThemePalette(THEME), look ?? IDENTITY_KEY),
      addressOf(root, name),
    ).hex;
  return { render, root, bgOf, fgOf, expectedTint, dispose: () => registry.dispose() };
}

const IDENTITY_KEY: ThemeKey = {
  hueShift: 0,
  chromaScale: 1,
  lightnessScale: 1,
  lightnessShift: 0,
};

const SRC = `{
  globals: { palette: '${THEME}' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    show: { kind: 'input', path: 'show', type: 'boolean', default: true },
  },
  segments: {
    a: { template: 'A', fg: 'foreground' },
    b: { template: 'B', fg: 'foreground' },
    c: { template: 'C', fg: 'foreground' },
    meaning: { template: 'M', bg: 'error', fg: 'foreground' },
    echo: { template: 'E', fg: '{{ bgOf }}' },
  },
  root: { v: [
    { h: ['a', 'b', { seg: 'c', when: '{{ .show }}' }] },
    { h: ['meaning', 'echo'] },
  ] },
}`;

describe("candybar-render-ai7.4 — the walk paints the closed cell with decorFor", () => {
  test("a segment with no `bg:` wears the vocabulary entry its address selects", () => {
    const rt = build(SRC);
    rt.render();
    for (const name of ["a", "b", "c", "echo"]) {
      expect([name, rt.bgOf(name)]).toEqual([name, rt.expectedTint(name)]);
    }
    expect(rt.bgOf("a")).not.toBe(rt.bgOf("b"));
    rt.dispose();
  });

  test("an authored `bg:` paints meaning over the tint", () => {
    const rt = build(SRC);
    rt.render();
    expect(rt.bgOf("meaning")).toBe(getThemePalette(THEME).get("error")!.hex);
    expect(rt.bgOf("meaning")).not.toBe(rt.expectedTint("meaning"));
    rt.dispose();
  });

  test("{{ bgOf }} in a `fg:` reads the tint when no bg is authored", () => {
    const rt = build(SRC);
    rt.render();
    expect(rt.fgOf("echo")).toBe(rt.expectedTint("echo"));
    rt.dispose();
  });

  test("hiding a sibling recolours nobody: an address is unchanged by a node being hidden", () => {
    const rt = build(SRC);
    rt.render({ show: true });
    const shown = ["a", "b", "meaning", "echo"].map((n) => rt.bgOf(n));
    rt.render({ show: false });
    expect(["a", "b", "meaning", "echo"].map((n) => rt.bgOf(n))).toEqual(shown);
    rt.dispose();
  });

  test("colour comes from where a segment sits, not from how many leaves precede it", () => {
    const rowTwoFirst = (rowOne: string): string => {
      const rt = build(`{
        globals: { palette: '${THEME}' },
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        segments: {
          a: { template: 'A' }, x: { template: 'X' }, y: { template: 'Y' },
          probe: { template: 'P' },
        },
        root: { v: [ { h: [${rowOne}] }, { h: ['probe'] } ] },
      }`);
      rt.render();
      const bg = rt.bgOf("probe");
      expect(bg).toBe(rt.expectedTint("probe"));
      rt.dispose();
      return bg;
    };
    expect(rowTwoFirst("'a'")).toBe(rowTwoFirst("'a', 'x', 'y'"));
  });

  test("the render's look reaches the tint: it is read from the one transposed palette", () => {
    const inverted: ThemeKey = {
      hueShift: 0,
      chromaScale: 1,
      lightnessScale: -1,
      lightnessShift: 1,
    };
    const plain = build(SRC);
    plain.render();
    const looked = build(SRC, inverted);
    looked.render();
    expect(looked.bgOf("a")).toBe(looked.expectedTint("a"));
    expect(looked.bgOf("a")).not.toBe(plain.bgOf("a"));
    plain.dispose();
    looked.dispose();
  });
});

// [LAW:behavior-not-structure] `bg:` is authored only for a threshold template or an alert role; everything else wears its address's tint.

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import type { SemanticRole } from "../src/themes/decor";

// [LAW:types-are-the-program] SemanticRole-keyed: a new role is a compile error here.
const ALERT_ROLE: Record<SemanticRole, true> = {
  error: true,
  success: true,
  warning: true,
};

/** A payload that trips every bundled threshold and reveals every alert. */
const HOT = {
  workspace: { current_dir: "/w/p", project_dir: "/w/p" },
  model: { display_name: "Opus" },
  git: { branch: "main", repoName: "p" },
  host: { ssh: true, user: "u", name: "h" },
  context: { totalTokens: 1000, contextLeft: 10 },
  block: { nativeUtilization: 95, resetsAt: 1, etaMinutes: 1 },
  weekly: { percentage: 95, resetsAt: 1, etaMinutes: 1 },
};

// `burnrate` isn't in the bundled root; merging by name adds it as a third row.
const BUNDLED = `{
  globals: { palette: '${THEME}' },
  root: { rows: { probe: { h: ['burnrate'] } } },
}`;

describe("candybar-render-ai7.5 — the bundled default authors a `bg:` only to state meaning", () => {
  test("every authored `bg:` is a threshold template or a hue-anchored alert role", () => {
    const authored = Object.entries(DEFAULT_DSL_CONFIG.segments).flatMap(
      ([name, seg]) => (seg.bg === undefined ? [] : [[name, seg.bg] as const]),
    );
    // [LAW:no-silent-failure] The sweep must still leave some segment stating meaning.
    expect(authored.length).toBeGreaterThan(0);
    for (const [name, bg] of authored) {
      expect([name, bg.includes("{{") || bg in ALERT_ROLE]).toEqual([name, true]);
    }
  });

  test("the threshold and alert cells still paint meaning over the tint", () => {
    const rt = build(BUNDLED, undefined, DEFAULT_DSL_CONFIG);
    rt.render(HOT);
    const palette = getThemePalette(THEME);
    const error = palette.get("error")!.hex;
    const warning = palette.get("warning")!.hex;
    expect(rt.bgOf("context")).toBe(error);
    expect(rt.bgOf("block")).toBe(error);
    expect(rt.bgOf("weekly")).toBe(error);
    expect(rt.bgOf("burnrate")).toBe(error);
    expect(rt.bgOf("host")).toBe(warning);
    for (const name of ["context", "block", "weekly", "burnrate", "host"]) {
      expect([name, rt.bgOf(name)]).not.toEqual([name, rt.expectedTint(name)]);
    }
    rt.dispose();
  });

  test("every other bundled cell — the settings door included — wears its address's tint", () => {
    const rt = build(BUNDLED, undefined, DEFAULT_DSL_CONFIG);
    rt.render(HOT);
    for (const name of ["directory", "model", "gitaculous", "toolbar", SETTINGS_ANCHOR]) {
      expect([name, rt.bgOf(name)]).toEqual([name, rt.expectedTint(name)]);
    }
    rt.dispose();
  });
});

// [LAW:behavior-not-structure] Expectations recompute the address without the authored field, so a compile that ignores it cannot satisfy the test.
describe("candybar-render-ai7.8 — `distribution` is authored per placer", () => {
  const CELLS = ["a", "b", "c", "d"] as const;
  const tree = (rowField: string, rootField = ""): string => `{
    globals: { palette: '${THEME}' },
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    segments: {
      a: { template: 'A' }, b: { template: 'B' }, c: { template: 'C' }, d: { template: 'D' },
    },
    root: { v: [ { h: ['a', 'b', 'c']${rowField} }, { h: ['d'] } ]${rootField} },
  }`;
  const tints = (src: string): readonly string[] => {
    const rt = build(src);
    rt.render();
    const out = CELLS.map((n) => rt.bgOf(n));
    rt.dispose();
    return out;
  };

  test("omitting the field renders byte-identical to `distribution: 'van-der-corput'`", () => {
    expect(tints(tree(""))).toEqual(tints(tree(", distribution: 'van-der-corput'")));
  });

  test("a row's authored distribution places that row's cells — and only that row's", () => {
    const plain = build(tree(""));
    const rt = build(tree(", distribution: 'monotonic'"));
    rt.render();
    const palette = transposedPalette(getThemePalette(THEME), IDENTITY_KEY);
    for (const name of ["a", "b", "c"]) {
      const address = addressOf(plain.root, name);
      const own = address[address.length - 1]!;
      const rePlaced: Address = [
        ...address.slice(0, -1),
        { ...own, distribution: DISTRIBUTIONS.monotonic },
      ];
      expect([name, rt.bgOf(name)]).toEqual([name, decorFor(palette, rePlaced).hex]);
    }
    plain.render();
    expect(["a", "b", "c"].map((n) => rt.bgOf(n))).not.toEqual(
      ["a", "b", "c"].map((n) => plain.bgOf(n)),
    );
    expect(rt.bgOf("d")).toBe(plain.bgOf("d"));
    plain.dispose();
    rt.dispose();
  });

  test("a whole-tree root's authored distribution places the ROWS: one placer in every cell's lineage moves, the one placing the authored rows", () => {
    const plain = build(tree(""));
    const rt = build(tree("", ", distribution: 'monotonic'"));
    rt.render();
    plain.render();
    const palette = transposedPalette(getThemePalette(THEME), IDENTITY_KEY);
    for (const name of CELLS) {
      const authored = addressOf(rt.root, name);
      const unauthored = addressOf(plain.root, name);
      // Lineage shape is unchanged; only the authored root's own step's placer differs.
      const shape = (a: Address) => a.map(({ index, count }) => ({ index, count }));
      expect(shape(authored)).toEqual(shape(unauthored));
      const moved = authored.filter(
        (step, i) => step.distribution !== unauthored[i]!.distribution,
      );
      expect([name, moved]).toEqual([
        name,
        [{ index: name === "d" ? 1 : 0, count: 2, distribution: DISTRIBUTIONS.monotonic }],
      ]);
      expect([name, rt.bgOf(name)]).toEqual([name, decorFor(palette, authored).hex]);
    }
    expect(CELLS.map((n) => rt.bgOf(n))).not.toEqual(
      CELLS.map((n) => plain.bgOf(n)),
    );
    plain.dispose();
    rt.dispose();
  });

  test("an unknown name is a load error naming the five", () => {
    expect(() => build(tree(", distribution: 'spiral'"))).toThrow(
      /distribution must be one of: van-der-corput, golden-angle, ends-interleaved, monotonic, uniform; got "spiral"/,
    );
  });

  test("a group carries the same field for its body", () => {
    const group = (field: string): string => `{
      globals: { palette: '${THEME}' },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { a: { template: 'A' }, b: { template: 'B' }, c: { template: 'C' } },
      root: { v: [
        { kind: 'group', name: 'more', label: 'more', open: true, direction: 'horizontal'${field},
          children: ['a', 'b', 'c'] },
      ] },
    }`;
    const plain = build(group(""));
    plain.render();
    const rt = build(group(", distribution: 'monotonic'"));
    rt.render();
    expect(["a", "b", "c"].map((n) => rt.bgOf(n))).not.toEqual(
      ["a", "b", "c"].map((n) => plain.bgOf(n)),
    );
    expect(rt.bgOf("groups.more")).toBe(plain.bgOf("groups.more"));
    expect(() => build(group(", distribution: 'spiral'"))).toThrow(
      /distribution must be one of: van-der-corput, golden-angle, ends-interleaved, monotonic, uniform/,
    );
    plain.dispose();
    rt.dispose();
  });
});
