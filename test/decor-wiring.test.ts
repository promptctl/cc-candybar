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

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { ColorDepth, getThemePalette, transposePalette } from "@promptctl/rich-js";
import type { RichText, ThemeKey } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { childStep, type CompiledNode } from "../src/dsl/node-registry";
import type { DslConfig } from "../src/config/dsl-types";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { PRESET_FLOOR } from "../src/config/presets";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import { EDIT_LIVE_KEY } from "../src/config/edit-chrome";
import { EDIT_NS } from "../src/config/reserved-names";
import {
  decorEntryFor,
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

// The depth every bar here is drawn at, and the one its expected tints are
// selected at.
const DRAWN_AT = ColorDepth.TRUECOLOR;

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
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  const sink = new Map<string, readonly RichText[]>();
  const render = (payload: object = {}, variation?: VariationName, shade?: ShadeName): Frame =>
    drawPayload(
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
    ).frame;
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
      DRAWN_AT,
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

const SHADE_NAMES = Object.keys(SHADES) as ShadeName[];
const FIVE = ["a", "b", "c", "d", "e"];

/**
 * A bar whose middle row is `cells`, with the row's own `fields` after them,
 * each of a…e gated on its own input (`sa` … `se`, and `sg` for a group's
 * gate), all shown by default. The settings door leads the first row and edit
 * mode's `(?)` trails the last, so the row under test holds only what it
 * authors.
 */
const groupedRow = (cells: string, fields = ""): string => `{
  globals: { palette: '${THEME}' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    ${[...FIVE, "g"].map((g) => `s${g}: { kind: 'input', path: 's${g}', type: 'boolean', default: true }`).join(",\n    ")},
  },
  segments: {
    y: { template: 'Y' },
    z: { template: 'Z' },
    ${FIVE.map((n) => `${n}: { template: '«${n}»', when: '{{ .s${n} }}' }`).join(",\n    ")},
  },
  root: { v: [ { h: ['y'] }, { h: ${cells}${fields} }, { h: ['z'] } ] },
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
    // Nor in a row whose middle cells are grouped, where every leaf takes its
    // own place, one group deep or two: hiding any one cell, or the gated
    // group, leaves every other cell's tone where it was, under every dial
    // position.
    const rows = [
      ["[ 'a', { h: [ 'b', 'c', 'd' ], when: '{{ .sg }}' }, 'e' ]", ["b", "c", "d"]],
      ["[ 'a', { h: [ 'b', { h: [ 'c', 'd' ], when: '{{ .sg }}' } ] }, 'e' ]", ["c", "d"]],
    ] as const;
    for (const [cells, group] of rows) {
      const grouped = build(groupedRow(cells));
      for (const shade of SHADE_NAMES) {
        grouped.render({}, undefined, shade);
        const before = new Map(FIVE.map((n) => [n, grouped.bgOf(n)]));
        for (const gate of [...FIVE, "g"]) {
          const drawn = grouped.render({ [`s${gate}`]: false }, undefined, shade);
          const gone: readonly string[] = gate === "g" ? group : [gate];
          expect([cells, gate, FIVE.filter((n) => textOf(drawn).includes(`«${n}»`))]).toEqual([cells, gate, FIVE.filter((n) => !gone.includes(n))]);
          for (const name of FIVE.filter((n) => !gone.includes(n))) {
            expect([cells, shade, gate, name, grouped.bgOf(name)]).toEqual([cells, shade, gate, name, before.get(name)]);
          }
        }
      }
      grouped.dispose();
    }
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
    // The variations paint these cells in as many distinct ways as the model
    // says they do — the lineage a variation's menus open in paints no closed
    // cell, and a keystone on the door or on `meaning` is off these cells.
    const forms = new Set(
      (Object.keys(VARIATIONS) as VariationName[]).map((variation) => names.map((n) => rt.expectedTint(n, variation)).join()),
    );
    expect(seen.size).toBe(forms.size);
    expect(forms.size).toBeGreaterThanOrEqual(6);
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

// Each window an hour from its reset at 95%: minutes from its cap at the
// rate it has run, whenever in this run it is drawn.
const HOT_NOW_SEC = Math.floor(Date.now() / 1000);

/** A payload that trips every bundled threshold and reveals every alert. */
const HOT = {
  workspace: { current_dir: "/w/p", project_dir: "/w/p" },
  model: { display_name: "Opus" },
  git: { branch: "main", repoName: "p" },
  host: { ssh: true, user: "u", name: "h" },
  context: { totalTokens: 1000, contextLeft: 10 },
  block: { nativeUtilization: 95, resetsAt: HOT_NOW_SEC + 3600 },
  weekly: { percentage: 95, resetsAt: HOT_NOW_SEC + 3600 },
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
      // The row places every step under it: its cells, and whatever they
      // nest — edit mode wraps each cell with its `+`/`-` in a unit that
      // shares the cell's place, placed by the row too.
      const address = addressOf(plain.root, name);
      const rePlaced: Address = address.map((step) =>
        step.axis === "cell" ? { ...step, distribution: DISTRIBUTIONS.monotonic } : step,
      );
      expect([name, rt.bgOf(name)]).toEqual([name, decorFor(palette, DEFAULT_DECOR, rePlaced, DRAWN_AT).hex]);
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
        [{ index: name === "d" ? 1 : 0, count: 2, distribution: DISTRIBUTIONS.uniform, axis: "row", lineStart: 0, lineEnd: 1 }],
      ]);
      expect([name, rt.bgOf(name)]).toEqual([name, decorFor(palette, DEFAULT_DECOR, authored, DRAWN_AT).hex]);
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

  test("a distribution inside a row is a load error, one message wherever it sits there: the row places every cell along its line", () => {
    const bar = (row: string): string => `{
      globals: { palette: '${THEME}' },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { a: { template: 'A' }, b: { template: 'B' }, c: { template: 'C' } },
      root: { v: [ { h: ${row} } ] },
    }`;
    const M = ", distribution: 'monotonic'";
    build(bar(`['a', { h: ['b', { h: ['c'] }] }]`)).dispose();
    // On a group nested in the row, on a container nested in that group, and
    // on a `{ v }` in the row: each placed nothing, and each says so alike.
    const refusals = [
      [`['a', { h: ['b', 'c']${M} }]`, "root.children[0].children[1]"],
      [`['a', { h: ['b', { h: ['c']${M} }] }]`, "root.children[0].children[1].children[1]"],
      [`['a', { v: ['b', 'c']${M} }]`, "root.children[0].children[1]"],
    ].map(([row, path]) => {
      let message = "";
      try {
        build(bar(row!)).dispose();
      } catch (error) {
        message = (error as Error).message;
      }
      expect([row, message]).toEqual([row, expect.stringContaining(`${path} sets "distribution" on a container inside a row`)]);
      return message.slice(message.indexOf(`${path} sets`) + path!.length);
    });
    expect(new Set(refusals).size).toBe(1);
  });

  test("a gated first row places its cells by its own distribution, as an ungated one does, though the door leads it from outside its gate", () => {
    const bar = (gate: string): string => `{
      globals: { palette: '${THEME}' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        x: { kind: 'input', path: 'x', type: 'boolean', default: true },
      },
      segments: { a: { template: 'A' }, b: { template: 'B' }, c: { template: 'C' } },
      root: { v: [ { h: ['a', 'b', 'c'], distribution: 'monotonic'${gate} } ] },
    }`;
    const open = build(bar(""));
    const gated = build(bar(", when: '{{ .x }}'"));
    open.render();
    gated.render();
    expect(["a", "b", "c"].map((n) => gated.bgOf(n))).toEqual(["a", "b", "c"].map((n) => open.bgOf(n)));
    open.dispose();
    gated.dispose();
  });

  test("on the bar, a distribution on a vertical container whose rows stack further in is a load error", () => {
    const bar = (tree: string): string => `{
      globals: { palette: '${THEME}' },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { a: { template: 'A' }, b: { template: 'B' } },
      root: ${tree},
    }`;
    const M = ", distribution: 'monotonic'";
    // A row ends where a segment or a horizontal container is: it places those.
    build(bar(`{ v: [ { h: ['a'] }, { v: ['b'] } ]${M} }`)).dispose();
    build(bar(`{ v: [ 'a', { v: ['b'] } ]${M} }`)).dispose();
    // Every row a vertical container: each row's hue is its own container's step.
    expect(() => build(bar(`{ v: [ { v: ['a'] }, { v: ['b'] } ]${M} }`))).toThrow(
      /sets "distribution" on a vertical container none of whose children is a segment or a horizontal container/,
    );
  });

  test("in a body, a distribution is refused where nothing reads it: inside a row, or on a vertical container", () => {
    const body = (tree: string): string => `{
      globals: { palette: '${THEME}' },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { a: { template: 'A' }, b: { template: 'B' }, c: { template: 'C' } },
      root: { v: [
        { kind: 'group', name: 'more', label: 'more', open: true, children: [ ${tree} ] },
      ] },
    }`;
    const M = ", distribution: 'monotonic'";
    // On the row whose children are the cells, it places them — even when a
    // cell is itself a container, since a cell's place is read whatever it holds.
    build(body(`{ v: [ { h: ['a', 'b']${M} } ] }`)).dispose();
    build(body(`{ h: [ { v: ['a'] }, { v: ['b'] } ]${M} }`)).dispose();
    // A body's rows pick nothing, whatever they hold; the message names the node.
    for (const tree of [`{ v: [ 'c', { h: ['a', 'b'] } ]${M} }`, `{ v: [ { h: ['a', 'b'] } ]${M} }`]) {
      expect(() => build(body(tree))).toThrow(
        /root\.children\[0\]\.opens\.body\.children\[0\] sets "distribution" on a vertical container in a disclosure body/,
      );
    }
    // Inside a body's row it places nothing, as on the bar: the row places
    // every item along its line, through a group nested in it.
    for (const tree of [`{ h: [ 'c', { h: ['a', 'b']${M} } ] }`, `{ h: [ 'c', { h: ['a', { h: ['b']${M} }] } ] }`]) {
      expect(() => build(body(tree))).toThrow(/sets "distribution" on a container inside a row/);
    }
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

// candybar-joiners-e5r4.3m7: a container inside a row is layout, not a colour
// unit. Its leaves sit side by side with the row's other cells, so each takes
// its own place on the row's line, and a row reads as the flat row of its
// leaves does, however it nests them.
describe("candybar-joiners-e5r4.3m7 — a row's leaves take their own places, however the row nests them", () => {
  const tints = (rt: ReturnType<typeof build>, names: readonly string[]): string[] => names.map((n) => rt.bgOf(n));

  test("a row authored as a, { h: [b, c, d] }, e draws five places: each cell wears what a flat row of five wears there, and no two neighbours share a tone", () => {
    const grouped = build(groupedRow("[ 'a', { h: [ 'b', 'c', 'd' ] }, 'e' ]"));
    const flat = build(groupedRow("[ 'a', 'b', 'c', 'd', 'e' ]"));
    // No dial position deals one tone, which would put every pair of
    // neighbours on it.
    expect(SHADE_NAMES.filter((shade) => SHADES[shade].tones.length < 2)).toEqual([]);
    for (const shade of SHADE_NAMES) {
      grouped.render({}, undefined, shade);
      flat.render({}, undefined, shade);
      expect([shade, tints(grouped, FIVE)]).toEqual([shade, tints(flat, FIVE)]);
      // The tone each cell's place selects, as the walk drew it.
      const tones = FIVE.map((n) => decorEntryFor(getThemePalette(THEME), decorOf(undefined, shade), addressOf(grouped.root, n), DRAWN_AT).shade);
      const alike = FIVE.slice(1).filter((n, i) => tones[i + 1] === tones[i]);
      expect([shade, alike]).toEqual([shade, []]);
    }
    grouped.dispose();
    flat.dispose();
  });

  test("with a group ending a row, only its last leaf wears the line-end keystone; under alt the hue run counts the group's leaves as cells", () => {
    const FOUR = FIVE.slice(0, 4);
    const grouped = build(groupedRow("[ 'a', { h: [ 'b', 'c', 'd' ] } ]"));
    const flat = build(groupedRow("[ 'a', 'b', 'c', 'd' ]"));
    const hues = (variation: VariationName) =>
      FOUR.map((n) => decorEntryFor(getThemePalette(THEME), decorOf(variation), addressOf(grouped.root, n), DRAWN_AT).hue);
    expect(hues("end-primary")).toEqual(["secondary", "secondary", "secondary", "accent"]);
    // The row under test is the bar's second, so alt starts it on its second
    // step and turns after three cells: at d, the group's last leaf.
    expect(hues("alt")).toEqual(["accent", "accent", "accent", "secondary"]);
    for (const variation of ["end-primary", "alt"] as const) {
      grouped.render({}, variation);
      flat.render({}, variation);
      expect([variation, tints(grouped, FOUR)]).toEqual([variation, tints(flat, FOUR)]);
    }
    grouped.dispose();
    flat.dispose();
  });

  test("a { v } inside a row draws its first child on the row's line and each other on a line below, each counting from where the { v } sits; the row's count is the farthest place any line reaches, and each line has its own ends", () => {
    // The { v } sits at place 1. Its second child, a group of three, draws on
    // a line of its own below the row and reaches place 3, past the row line's
    // last place: a count of the row line's two places would put d and e
    // outside the row, where a count-reading distribution places nothing.
    const rt = build(groupedRow("[ 'a', { v: [ 'b', { h: [ 'c', 'd', 'e' ] } ] } ]", ", distribution: 'monotonic'"));
    const drawn = rt.render();
    const lines = textOf(drawn)
      .split("\n")
      .map((line) => [...line.matchAll(/«(\w)»/g)].map(([, name]) => name))
      .filter((names) => names.length > 0);
    expect(lines).toEqual([["a", "b"], ["c", "d", "e"]]);
    const places = Object.fromEntries(
      FIVE.map((n) => {
        const { index, count } = addressOf(rt.root, n).at(-1)!;
        return [n, [index, count]];
      }),
    );
    expect(places).toEqual({ a: [0, 4], b: [1, 4], c: [1, 4], d: [2, 4], e: [3, 4] });
    for (const shade of SHADE_NAMES) {
      rt.render({}, undefined, shade);
      expect([shade, tints(rt, FIVE)]).toEqual([shade, FIVE.map((n) => rt.expectedTint(n, undefined, shade))]);
    }
    // Every drawn line has its own ends: b ends the row's line though d and e
    // reach further on the line below, and c starts that line.
    const hues = (variation: VariationName) =>
      FIVE.map((n) => decorEntryFor(getThemePalette(THEME), decorOf(variation), addressOf(rt.root, n), DRAWN_AT).hue);
    expect(hues("end-primary")).toEqual(["secondary", "accent", "secondary", "secondary", "accent"]);
    expect(hues("start-primary")).toEqual(["accent", "secondary", "accent", "secondary", "secondary"]);
    for (const variation of ["end-primary", "start-primary"] as const) {
      rt.render({}, variation);
      expect([variation, tints(rt, FIVE)]).toEqual([variation, FIVE.map((n) => rt.expectedTint(n, variation))]);
    }
    rt.dispose();
  });

  test("an empty container draws no line, so a { v } whose first child is empty draws its next child on the row's line, at a place of its own", () => {
    const rt = build(groupedRow("[ 'a', { v: [ { h: [] }, 'b' ] }, 'c' ]"));
    const lines = textOf(rt.render())
      .split("\n")
      .map((line) => [...line.matchAll(/«(\w)»/g)].map(([, name]) => name))
      .filter((names) => names.length > 0);
    expect(lines).toEqual([["a", "b", "c"]]);
    const THREE = FIVE.slice(0, 3);
    const places = THREE.map((n) => {
      const { index, count, lineStart, lineEnd } = addressOf(rt.root, n).at(-1)!;
      return [n, index, count, lineStart, lineEnd];
    });
    expect(places).toEqual([
      ["a", 0, 3, 0, 2],
      ["b", 1, 3, 0, 2],
      ["c", 2, 3, 0, 2],
    ]);
    rt.dispose();
  });

  test("edit chrome keeps one place per content cell, so a grouped row wears in edit mode what it wears outside it", () => {
    const rt = build(groupedRow("[ 'a', { h: [ 'b', 'c', 'd' ] }, 'e' ]"));
    rt.render();
    const closed = tints(rt, FIVE);
    rt.sessionState.set("s1", EDIT_MODE_KEY, "arrange");
    rt.sessionState.set("s1", EDIT_LIVE_KEY, "open");
    rt.render();
    expect(tints(rt, FIVE)).toEqual(closed);
    rt.dispose();
  });
});
