// candybar-render-ai7.4 — the tint half of decorative colour by address, as the
// render walk delivers it. [LAW:behavior-not-structure] Every expectation is
// computed from the model (decorFor over the segment's address in the compiled
// tree), never from a captured byte string, so any walk that honours the
// contract passes.
//
// The contract:
//   - a segment that authors no `bg:` wears the vocabulary entry its ADDRESS
//     selects — the tint is the floor every segment has;
//   - an authored `bg:` states meaning and paints over it;
//   - `{{ bgOf }}` reads the effective background, tint included;
//   - colour derives from WHERE a segment sits, not from how many leaves
//     precede it in the walk (the hue cursor's defining flaw);
//   - the render's style reaches the tint, because the tint is read from the
//     one transposed palette every unpinned segment colours from.

import { ColorRgba, getThemePalette, Palette, transposePalette } from "@promptctl/rich-js";
import type { RichText, ThemeKey } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl, type RenderWarning } from "../src/dsl/render";
import { childStep, type CompiledNode } from "../src/dsl/node-registry";
import type { DslConfig } from "../src/config/dsl-types";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { PRESET_FLOOR } from "../src/config/presets";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import { EDIT_LIVE_KEY } from "../src/config/edit-chrome";
import { EDIT_NS } from "../src/config/loader/reserved-namespace";
import {
  decorFor,
  DISTRIBUTIONS,
  SHADES,
  VARIATIONS,
  type Address,
  type ShadeName,
  type VariationName,
} from "../src/themes/decor";
import { DEFAULT_DECOR, decorOf } from "./helpers/decor";


const ALLOWED = new Set(listResolvablePaletteNames());
const THEME = "textual-dark";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};

/** The address of the segment named `name` in a compiled tree, or throw. */
function addressOf(root: CompiledNode, name: string): Address {
  const walk = (node: CompiledNode, address: Address): Address | undefined => {
    if (node.kind === "segment") return node.name === name ? address : undefined;
    for (const [index, child] of node.children.entries()) {
      const found = walk(child, [
        ...address,
        childStep(node, index),
      ]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const found = walk(root, []);
  if (found === undefined) throw new Error(`no segment "${name}" in the tree`);
  return found;
}

/** Every segment of a compiled tree, with its address. */
function segmentAddresses(root: CompiledNode): { name: string; address: Address }[] {
  const walk = (node: CompiledNode, address: Address): { name: string; address: Address }[] =>
    node.kind === "segment"
      ? [{ name: node.name, address }]
      : node.children.flatMap((child, index) => walk(child, [...address, childStep(node, index)]));
  return walk(root, []);
}

function build(src: string, look?: ThemeKey, dflt?: DslConfig) {
  const config = parseAndValidate("<test>", src, ALLOWED, dflt);
  const store = new VariableStore();
  const sessionState = new SessionState();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
  const sink = new Map<string, readonly RichText[]>();
  const render = (payload: object = {}, variation?: VariationName, shade?: ShadeName): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: "s1", ...payload },
      instantOf(new Date()),
      OPTS,
      { perSegmentSink: sink },
      selectionFor(config, {
        ...(look === undefined ? {} : { style: { kind: "decided" as const, name: "test", value: look } }),
        ...(variation === undefined ? {} : { variation }),
        ...(shade === undefined ? {} : { shade }),
      }),
    );
  const root = compiled.roots.get(PRESET_FLOOR)!;
  const bgOf = (name: string): string => {
    const cell = sink.get(name)?.[0];
    if (cell === undefined) throw new Error(`segment "${name}" did not render`);
    return resolvedStyle(cell.style).bgcolor?.value?.hex ?? "(no bg)";
  };
  const fgOf = (name: string): string =>
    resolvedStyle(sink.get(name)![0]!.style).color?.value?.hex ?? "(no fg)";
  // [LAW:behavior-not-structure] rich-js `transposePalette` directly, never the
  // render's memoized `transposedPalette`: the function under test cannot be
  // the oracle that checks it.
  const expectedTint = (name: string, variation?: VariationName, shade?: ShadeName): string =>
    decorFor(
      transposePalette(getThemePalette(THEME), look ?? IDENTITY_KEY),
      decorOf(variation, shade),
      addressOf(root, name),
    ).hex;
  return { render, root, bgOf, fgOf, expectedTint, sessionState, dispose: () => registry.dispose() };
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
    d: { template: 'D', fg: 'foreground' },
    f: { template: 'F', fg: 'foreground' },
    meaning: { template: 'M', bg: 'error', fg: 'foreground' },
    echo: { template: 'E', fg: '{{ bgOf }}' },
  },
  root: { v: [
    { h: ['a', 'b', { seg: 'c', when: '{{ .show }}' }] },
    { h: ['meaning', 'echo', 'd', 'f'] },
  ] },
}`;

describe("candybar-render-ai7.4 — the walk paints the closed cell with decorFor", () => {
  test("a segment with no `bg:` wears the vocabulary entry its address selects", () => {
    const rt = build(SRC);
    rt.render();
    for (const name of ["a", "b", "c", "echo"]) {
      expect([name, rt.bgOf(name)]).toEqual([name, rt.expectedTint(name)]);
    }
    // Variety with nothing authored: adjacent siblings are dealt different
    // entries — the whole point of the vocabulary.
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
    // Row 2's first cell is at the same address whether row 1 holds one leaf
    // or three; under the old pre-order cursor its index — and so its colour
    // — would have moved with row 1's leaf count.
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

  // brandon-theme-picker-bgw.7g6: which role each row wears is the render's
  // selection, not a constant of the colour model.
  test("the variation reaches every closed cell: row n wears step n of the one selected", () => {
    const rt = build(SRC);
    // Row 2 has four cells and no synthesized lead, so a variation that turns
    // along the row is told apart by the row's own authored cells.
    const names = ["a", "b", "c", "echo", "d", "f"];
    const seen = new Set<string>();
    for (const variation of Object.keys(VARIATIONS) as VariationName[]) {
      rt.render({}, variation);
      for (const name of names) {
        expect([variation, name, rt.bgOf(name)]).toEqual([variation, name, rt.expectedTint(name, variation)]);
      }
      seen.add(names.map((n) => rt.bgOf(n)).join());
    }
    // Every shipped variation paints this two-row bar differently.
    expect(seen.size).toBe(Object.keys(VARIATIONS).length);
    // An omitting caller renders the default: secondary on row 1, accent on row 2.
    rt.render();
    for (const name of names) expect(rt.bgOf(name)).toBe(rt.expectedTint(name, "accent"));
    rt.dispose();
  });

  // candybar-theme-colours-6fq5.e5n: which of its role's shades each cell
  // wears is the render's selection too, beside the variation.
  test("the shade reaches every closed cell: each wears its role at the shade the dial selects", () => {
    const rt = build(SRC);
    const names = ["a", "b", "c", "echo", "d", "f"];
    const seen = new Set<string>();
    for (const shade of Object.keys(SHADES) as ShadeName[]) {
      rt.render({}, undefined, shade);
      for (const name of names) {
        expect([shade, name, rt.bgOf(name)]).toEqual([shade, name, rt.expectedTint(name, undefined, shade)]);
      }
      seen.add(names.map((n) => rt.bgOf(n)).join());
    }
    // Every position of the dial paints this bar differently.
    expect(seen.size).toBe(Object.keys(SHADES).length);
    // An omitting caller renders the default: the window around each role.
    rt.render();
    for (const name of names) expect(rt.bgOf(name)).toBe(rt.expectedTint(name, undefined, "middle"));
    rt.dispose();
  });

  test("globals.variation is the config's default under an omitting caller", () => {
    const rt = build(SRC.replace(`globals: { palette: '${THEME}' }`, `globals: { palette: '${THEME}', variation: 'mono' }`));
    rt.render();
    for (const name of ["a", "b", "c", "echo"]) {
      expect([name, rt.bgOf(name)]).toEqual([name, rt.expectedTint(name, "mono")]);
    }
    rt.dispose();
  });

  test("globals.shade is the config's default under an omitting caller", () => {
    const rt = build(SRC.replace(`globals: { palette: '${THEME}' }`, `globals: { palette: '${THEME}', shade: 'muted' }`));
    rt.render();
    for (const name of ["a", "b", "c", "echo"]) {
      expect([name, rt.bgOf(name)]).toEqual([name, rt.expectedTint(name, undefined, "muted")]);
    }
    rt.dispose();
  });

  test("edit chrome wears its content cell's colour, in a row of many or a row of one", () => {
    // Edit chrome wraps each content cell with its `+`/`-` as ONE unit that
    // sits where the cell sat, so the unit is one colour, whatever the row.
    // `solo` is a middle row: the first row gains the settings door and the
    // last the `(?)`, either of which would make a one-cell row two cells.
    const rt = build(`{
      globals: { palette: '${THEME}' },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { a: { template: 'A' }, b: { template: 'B' }, solo: { template: 'S' }, c: { template: 'C' } },
      root: { v: [ { h: ['a', 'b'] }, 'solo', { h: ['c'] } ] },
    }`);
    rt.sessionState.set("s1", EDIT_MODE_KEY, "arrange");
    rt.sessionState.set("s1", EDIT_LIVE_KEY, "open");
    rt.render();
    const live = new Map(["a", "solo"].map((c) => [c, rt.bgOf(c)]));
    rt.sessionState.set("s1", EDIT_LIVE_KEY, "closed");
    rt.render();
    const sameStep = (x: Address[number], y: Address[number]): boolean =>
      x.index === y.index && x.count === y.count && x.axis === y.axis;
    for (const content of ["a", "solo"]) {
      const unit = addressOf(rt.root, content).slice(0, -1);
      const members = segmentAddresses(rt.root).filter(
        ({ address }) =>
          address.length === unit.length + 1 &&
          unit.every((step, i) => sameStep(step, address[i]!)),
      );
      // The label, the content, and the `- +` cell (and the row's leading `+`).
      expect(members.length).toBeGreaterThanOrEqual(3);
      // Names view: every member but the content (which yields its cell to
      // its label) renders. The label wears the colour the live content wears;
      // an insertion point (`✚`) is drawn on no fill at all.
      for (const { name } of members.filter(({ name }) => name !== content)) {
        const expected = name.startsWith(`${EDIT_NS}${PRESET_FLOOR}.insertSeg.`)
          ? "(no bg)"
          : live.get(content);
        expect([content, name, rt.bgOf(name)]).toEqual([content, name, expected]);
      }
    }
    rt.dispose();
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

// --- candybar-render-ai7.5: the bundled default spends no role on decoration --
//
// Before .5 the bundled segments named `surface` / `panel` / `surface-active`
// so that neighbours would look different — hand-curated variety the
// vocabulary now supplies by address. What survives is MEANING: a threshold
// template (context / block / weekly / burnrate) or a hue-anchored alert
// (host's `warning`). [LAW:behavior-not-structure] The first test states that
// rule over whatever the bundled config declares — a new segment joins the
// rule by existing; the second and third measure the rendered cells.

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import type { SemanticRole } from "../src/themes/decor";
import { resolvedStyle } from "../src/render/rich-theme.js";
import { instantOf } from "../src/utils/instant";
import { selectionFor } from "./helpers/selection";

// [LAW:types-are-the-program] Keyed on the SemanticRole union, so a role added
// to (or removed from) the type is a compile error here, not a silent gap.
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

// `burnrate` is declared but opt-in (not in the bundled root); a third row
// merged by name roots it beside the bundled identity/status rows.
const BUNDLED = `{
  globals: { palette: '${THEME}' },
  root: { rows: { probe: { h: ['burnrate'] } } },
}`;

describe("candybar-render-ai7.5 — the bundled default authors a `bg:` only to state meaning", () => {
  test("every authored `bg:` is a threshold template or a hue-anchored alert role", () => {
    const authored = Object.entries(DEFAULT_DSL_CONFIG.segments).flatMap(
      ([name, seg]) => (seg.bg === undefined ? [] : [[name, seg.bg] as const]),
    );
    // [LAW:no-silent-failure] The sweep must not have taken the
    // meaning-bearing specs with it: some segment still states something.
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

  test("every other bundled cell wears its address's tint", () => {
    const rt = build(BUNDLED, undefined, DEFAULT_DSL_CONFIG);
    rt.render(HOT);
    for (const name of ["directory", "model", "gitaculous", SETTINGS_ANCHOR]) {
      expect([name, rt.bgOf(name)]).toEqual([name, rt.expectedTint(name)]);
    }
    rt.dispose();
  });
});

// [LAW:verifiable-goals] candybar-render-ai7.8: the distribution is an
// authored, per-instance field. Each test is one line of the ticket's
// Done-when. [LAW:behavior-not-structure] Expectations are bytes out for a
// config in — the "authored row" case computes its expectation from the MODEL
// over an address built WITHOUT the field, re-placing the row's own step, so a
// compile that ignored the field could not satisfy it.
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
    const palette = transposePalette(getThemePalette(THEME), IDENTITY_KEY);
    for (const name of ["a", "b", "c"]) {
      // The row places its cells at the step after the row's own; edit mode
      // wraps each cell with its `+`/`-`, whose placer is not the row's.
      const address = addressOf(plain.root, name);
      const own = address.findLastIndex((step) => step.axis === "row") + 1;
      const rePlaced: Address = address.map((step, i) =>
        i === own ? { ...step, distribution: DISTRIBUTIONS.monotonic } : step,
      );
      expect([name, rt.bgOf(name)]).toEqual([name, decorFor(palette, DEFAULT_DECOR, rePlaced).hex]);
    }
    // The field reached the tint: the row no longer matches its unauthored self…
    plain.render();
    expect(["a", "b", "c"].map((n) => rt.bgOf(n))).not.toEqual(
      ["a", "b", "c"].map((n) => plain.bgOf(n)),
    );
    // …and the sibling row is an instance of its own, untouched.
    expect(rt.bgOf("d")).toBe(plain.bgOf("d"));
    plain.dispose();
    rt.dispose();
  });

  test("a whole-tree root's authored distribution places the ROWS: one placer in every cell's lineage moves, the one placing the authored rows", () => {
    const plain = build(tree(""));
    // `uniform` places both rows in one half, so both wear one hue where the
    // default alternates them.
    const rt = build(tree("", ", distribution: 'uniform'"));
    rt.render();
    plain.render();
    const palette = transposePalette(getThemePalette(THEME), IDENTITY_KEY);
    for (const name of CELLS) {
      const authored = addressOf(rt.root, name);
      const unauthored = addressOf(plain.root, name);
      // Same lineage — synthesis wraps the authored root, and that wrapper
      // and every row keep their own placement…
      const shape = (a: Address) => a.map(({ index, count }) => ({ index, count }));
      expect(shape(authored)).toEqual(shape(unauthored));
      // …while exactly one step's placer changed: the authored root's, whose
      // two rows hold `a b c` (row 0) and `d` (row 1).
      const moved = authored.filter(
        (step, i) => step.distribution !== unauthored[i]!.distribution,
      );
      expect([name, moved]).toEqual([
        name,
        [{ index: name === "d" ? 1 : 0, count: 2, distribution: DISTRIBUTIONS.uniform, axis: "row" }],
      ]);
      expect([name, rt.bgOf(name)]).toEqual([name, decorFor(palette, DEFAULT_DECOR, authored).hex]);
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

  test("a distribution inside a bar cell is a load error: the cell's contents wear its tone", () => {
    const nested = (field: string): string => `{
      globals: { palette: '${THEME}' },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { a: { template: 'A' }, b: { template: 'B' }, c: { template: 'C' } },
      root: { v: [ { h: ['a', { h: ['b', 'c']${field} }] } ] },
    }`;
    build(nested("")).dispose();
    expect(() => build(nested(", distribution: 'monotonic'"))).toThrow(
      /sets "distribution" on a container inside a bar cell/,
    );
  });

  test("a distribution in a body on a container with no segment child is a load error: a body's cells read their own step", () => {
    const body = (inner: string, outer: string): string => `{
      globals: { palette: '${THEME}' },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { a: { template: 'A' }, b: { template: 'B' } },
      root: { v: [
        { kind: 'group', name: 'more', label: 'more', open: true,
          children: [ { v: [ { h: ['a', 'b']${inner} } ]${outer} } ] },
      ] },
    }`;
    // On the container whose children are the segments, it places them.
    build(body(", distribution: 'monotonic'", "")).dispose();
    expect(() => build(body("", ", distribution: 'monotonic'"))).toThrow(
      /sets "distribution" on a container inside a disclosure body none of whose children is a segment/,
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

describe("an open trigger on a row no colour stands off", () => {
  // nord, with its secondary row's shades pulled to black, mid grey and white:
  // every colour sits within 2.2:1 of one of them, so no open state clears the
  // first row's ground under the default shade.
  const straddling = new Palette(
    "straddling",
    true,
    new Map<string, ColorRgba>([
      ...getThemePalette("nord")!.vars,
      ["secondary-darken-1", new ColorRgba(0, 0, 0)],
      ["secondary", new ColorRgba(0x77, 0x77, 0x77)],
      ["secondary-lighten-1", new ColorRgba(0xff, 0xff, 0xff)],
    ]),
  );

  test("still opens: the bar and the body render, and the shortfall is reported once", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        segments: { inner: { template: 'INNER-BODY' } },
        root: { v: [ { kind: 'group', name: 'details', label: 'details', open: true, children: ['inner'] } ] },
      }`,
      ALLOWED,
    );
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, new SessionState());
    const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
    const errors: string[] = [];
    const warnings: RenderWarning[] = [];
    const out = renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: "s1" },
      instantOf(new Date()),
      OPTS,
      {
        onSegmentError: (name, message) => errors.push(`${name}: ${message}`),
        onRenderWarning: (warning) => warnings.push(warning),
      },
      selectionFor(config, { theme: { kind: "decided", name: "straddling", value: straddling } }),
    );
    expect(errors).toEqual([]);
    expect(out).toContain("INNER-BODY");
    expect(warnings).toEqual([
      {
        kind: "band-floor",
        message: expect.stringMatching(/^theme "straddling": no open-trigger colour stands 2\.2:1 off every cell beside it — the nearest stands \d\.\d\d:1 as drawn at depth TRUECOLOR; another shade or variation clears it$/),
      },
    ]);
    registry.dispose();
  });
});

describe("an open band whose plane stands on its trigger", () => {
  // nord washed out the way a style can wash a palette: the accent, the
  // background and the foreground all but meet, over a first row dark enough
  // that the accent stands off it as it is — so the open state is the accent,
  // and no plane recedes from it.
  const washed = new Palette(
    "washed",
    true,
    new Map<string, ColorRgba>([
      ...getThemePalette("nord")!.vars,
      ["accent", new ColorRgba(0xff, 0xff, 0xff)],
      ["background", new ColorRgba(0xff, 0xff, 0xff)],
      ["foreground", new ColorRgba(0xf4, 0xf4, 0xf4)],
      ["secondary-darken-1", new ColorRgba(0x20, 0x20, 0x20)],
      ["secondary", new ColorRgba(0x30, 0x30, 0x30)],
      ["secondary-lighten-1", new ColorRgba(0x40, 0x40, 0x40)],
    ]),
  );

  test("still renders its body, and reports the plane once", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        segments: { inner: { template: 'INNER-BODY' } },
        root: { v: [ { kind: 'group', name: 'details', label: 'details', open: true, children: ['inner'] } ] },
      }`,
      ALLOWED,
    );
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, new SessionState());
    const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
    const errors: string[] = [];
    const warnings: RenderWarning[] = [];
    const out = renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: "s1" },
      instantOf(new Date()),
      OPTS,
      {
        onSegmentError: (name, message) => errors.push(`${name}: ${message}`),
        onRenderWarning: (warning) => warnings.push(warning),
      },
      selectionFor(config, { theme: { kind: "decided", name: "washed", value: washed } }),
    );
    expect(errors).toEqual([]);
    expect(out).toContain("INNER-BODY");
    expect(warnings).toEqual([
      {
        kind: "band-floor",
        message: expect.stringMatching(/^theme "washed": an open band's plane stands ΔE 0\.\d{3} off the trigger that opened it as drawn at depth TRUECOLOR, under the 0\.1 that tells them apart; another style clears it$/),
      },
    ]);
    registry.dispose();
  });
});
