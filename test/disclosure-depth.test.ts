// [LAW:behavior-not-structure] Every expectation is computed from the colour
// model, never from a captured byte string.

import { getThemePalette } from "@promptctl/rich-js";
import type { Palette, RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import type { CompiledContainerNode, CompiledNode } from "../src/dsl/node-registry";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { PRESET_FLOOR } from "../src/config/presets";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { menuPageKey } from "../src/config/menu-keys";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import {
  BAR_ROOT,
  bandFor,
  bandItemFor,
  bandRoot,
  decorEntryFor,
  decorFor,
  decorationFor,
  descend,
  textOn,
  type Disclosure,
  type Region,
} from "../src/themes/decor";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH, VERB_SET_STATE } from "../src/click/wire";

const ALLOWED = new Set(listResolvablePaletteNames());
const THEME = "textual-dark";
const SID = "s1";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// Static effective values, so the bundled settings menu's labels resolve.
const PAYLOAD = {
  session_id: SID,
  cwd: "/tmp/proj",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: { current_dir: "/tmp/proj", project_dir: "/tmp/proj", added_dirs: [] },
  theme: { effective: THEME },
  look: { effective: "none" },
  style: { effective: "powerline" },
  preset: { effective: "default" },
  charset: { effective: "unicode" },
  colorCompatibility: { effective: "truecolor" },
  autoWrap: { effective: true },
  padding: { effective: 1 },
  show: true,
};

/** The region of `name` by the walk's own two moves: a container's child is one
 * step down in the same region; a trigger's body starts at its band's root. */
function regionOf(root: CompiledNode, palette: Palette, name: string): Region {
  const walk = (node: CompiledNode, region: Region): Region | undefined => {
    if (node.kind === "segment") {
      if (node.name === name) return region;
      return node.opens === undefined
        ? undefined
        : walk(
            node.opens.body,
            bandRoot(decorationFor(palette, region).disclosure),
          );
    }
    for (const [index, child] of node.children.entries()) {
      const found = walk(
        child,
        descend(region, {
          index,
          count: node.children.length,
          distribution: node.distribution,
        }),
      );
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const found = walk(root, BAR_ROOT);
  if (found === undefined) throw new Error(`no segment "${name}" in the tree`);
  return found;
}

function bodyCellsOf(root: CompiledNode, trigger: string): string[] {
  const find = (node: CompiledNode): CompiledContainerNode | undefined => {
    if (node.kind === "segment") {
      if (node.name === trigger) return node.opens?.body;
      return node.opens === undefined ? undefined : find(node.opens.body);
    }
    for (const child of node.children) {
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const body = find(root);
  if (body === undefined) throw new Error(`"${trigger}" opens no body`);
  return body.children.flatMap((c) => (c.kind === "segment" ? [c.name] : []));
}

function build(src: string, withDefault = false) {
  const config = parseAndValidate(
    "<test>",
    src,
    ALLOWED,
    withDefault ? DEFAULT_DSL_CONFIG : undefined,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const palette = getThemePalette(THEME);
  const sink = new Map<string, readonly RichText[]>();
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const ctx: VerbContext = testVerbContext(sessionState);
  // [LAW:no-silent-failure] A throwing segment skips the sink, reading as "did not render".
  const render = (): string => {
    const errors: string[] = [];
    const out = renderDsl(config, compiled, store, registry, PAYLOAD, palette, OPTS, {
      perSegmentSink: sink,
      onSegmentError: (name, message) => errors.push(`${name}: ${message}`),
    });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return out;
  };
  const root = compiled.roots.get(PRESET_FLOOR)!;
  // The sink holds a segment's lines flattened: inline cell first, then dropped lines.
  const cellsOf = (name: string): readonly RichText[] => {
    const cells = sink.get(name);
    if (cells === undefined || cells.length === 0) {
      throw new Error(`segment "${name}" did not render`);
    }
    return cells;
  };
  const bgOf = (name: string): string =>
    cellsOf(name)[0]!.style?.bgcolor?.value?.hex ?? "(no bg)";
  const fgOf = (name: string): string =>
    cellsOf(name)[0]!.style?.color?.value?.hex ?? "(no fg)";
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) {
      const handler = VERBS.get(e.verb);
      if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
      handler(e.value, ctx);
    }
  };
  const urlsIn = (name: string): string[] =>
    cellsOf(name)[0]!.spans.flatMap((s) =>
      typeof s.style !== "string" && s.style.link !== undefined
        ? [s.style.link]
        : [],
    );
  const clickWriting = (name: string, key: string, value: string): void => {
    const url = urlsIn(name).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (url === undefined) {
      throw new Error(`"${name}" renders nothing writing ${key}=${value}`);
    }
    click(url);
  };
  // The opener is the set-state whose 4th arg is the page key of its 2nd.
  const openMenuIn = (name: string): void => {
    const url = urlsIn(name).find((u) =>
      effectsOf(u).some(
        (e) =>
          e.verb === VERB_SET_STATE &&
          e.args[3] === menuPageKey(e.args[1] ?? "") &&
          e.args[2] !== DISCLOSURE_CLOSED,
      ),
    );
    if (url === undefined) throw new Error(`"${name}" hosts no menu opener`);
    click(url);
  };
  const expectedTint = (name: string): string =>
    decorationFor(palette, regionOf(root, palette, name)).tint.hex;
  const hueOf = (name: string): Disclosure["hue"] => {
    const region = regionOf(root, palette, name);
    if (region.kind !== "bar") throw new Error(`"${name}" is not on the bar`);
    return decorEntryFor(region.address).hue;
  };
  return {
    palette,
    root,
    render,
    cellsOf,
    bgOf,
    fgOf,
    clickWriting,
    openMenuIn,
    expectedTint,
    hueOf,
    dispose: () => {
      disposers.forEach((d) => d());
      registry.dispose();
    },
  };
}

// The bundled default with a two-cell first row: ☰ lands after `model`.
const BUNDLED = `{ globals: { palette: '${THEME}' }, root: { h: ['directory', 'model'] } }`;

describe("candybar-render-ai7.9 — the bundled ☰ → ⚙ → picker chain, depth by depth", () => {
  test("each trigger wears the state of the band at its depth, and its cells are that band's items", () => {
    const rt = build(BUNDLED, true);
    const { palette, root } = rt;
    rt.render();
    const hue = rt.hueOf(SETTINGS_ANCHOR);

    expect(rt.bgOf(SETTINGS_ANCHOR)).toBe(rt.expectedTint(SETTINGS_ANCHOR));

    rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_ANCHOR, "open");
    rt.render();
    const band0: Disclosure = { hue, depth: 0 };
    expect(rt.bgOf(SETTINGS_ANCHOR)).toBe(bandFor(palette, band0).state.hex);
    const row1 = bodyCellsOf(root, SETTINGS_ANCHOR);
    expect(row1.length).toBeGreaterThan(2);
    const config = row1.find((n) => n.endsWith(".config"));
    if (config === undefined) throw new Error("no ⚙ config cell in the ☰ body");
    for (const [index, name] of row1.entries()) {
      const address = regionAddress(rt, name);
      expect(address).toMatchObject([{ index, count: row1.length }]);
      const item = bandItemFor(palette, band0, address);
      expect([name, rt.bgOf(name)]).toEqual([name, item.hex]);
      expect([name, rt.fgOf(name)]).toEqual([name, textOn(palette, item).hex]);
    }

    rt.clickWriting(config, config, "open");
    rt.render();
    const band1: Disclosure = { hue, depth: 1 };
    expect(rt.bgOf(config)).toBe(bandFor(palette, band1).state.hex);
    const row2 = bodyCellsOf(root, config);
    expect(row2.length).toBeGreaterThan(2);
    for (const name of row2) {
      expect([name, rt.bgOf(name)]).toEqual([name, rt.expectedTint(name)]);
      expect([name, rt.fgOf(name)]).toEqual([
        name,
        textOn(palette, bandItemFor(palette, band1, regionAddress(rt, name))).hex,
      ]);
    }

    const control = row2[0]!;
    rt.openMenuIn(control);
    rt.render();
    const band2 = bandFor(palette, { hue, depth: 2 });
    expect(rt.bgOf(control)).toBe(band2.state.hex);
    const [, drop] = rt.cellsOf(control);
    if (drop === undefined) throw new Error(`"${control}" dropped no line`);
    expect(drop.style?.bgcolor?.value?.hex).toBe(band2.plane.hex);
    rt.dispose();
  });
});

function regionAddress(rt: ReturnType<typeof build>, name: string) {
  const region = regionOf(rt.root, rt.palette, name);
  if (region.kind !== "band") throw new Error(`"${name}" is not on a band`);
  return region.address;
}

const MENU_SRC = (row2: string): string => `{
  globals: { palette: '${THEME}' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    show: { kind: 'input', path: 'show', type: 'boolean', default: true },
  },
  actions: { applyTheme: { set: 'theme', from: 'themes' } },
  segments: {
    a: { template: 'A' },
    m: { template: 'T {{ menu "applyTheme" "▸" "▾" }}' },
  },
  root: { v: [ { h: ['a'] }, ${row2} ] },
}`;

describe("candybar-render-ai7.9 — an authored `when` container is not a disclosure", () => {
  test.each([
    ["a gated row", `{ h: ['m'] }`, `{ h: ['m'], when: '{{ .show }}' }`],
    [
      "a gated row inside a gated column",
      `{ v: [ { h: ['m'] } ] }`,
      `{ v: [ { h: ['m'], when: '{{ .show }}' } ], when: '{{ .show }}' }`,
    ],
  ])("%s adds no depth: the open menu renders byte-identical to the ungated tree", (_label, plain, gated) => {
    const outputs = [plain, gated].map((row2) => {
      const rt = build(MENU_SRC(row2));
      rt.render();
      rt.openMenuIn("m");
      const out = rt.render();
      const band = bandFor(rt.palette, { hue: rt.hueOf("m"), depth: 0 });
      expect(rt.bgOf("m")).toBe(band.state.hex);
      expect(rt.cellsOf("m")[1]?.style?.bgcolor?.value?.hex).toBe(band.plane.hex);
      rt.dispose();
      return out;
    });
    expect(outputs[1]).toBe(outputs[0]);
  });
});

const GROUP_SRC = `{
  globals: { palette: '${THEME}' },
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  segments: {
    a: { template: 'A' },
    b: { template: 'B', fg: 'error' },
    c: { template: 'C' },
    d: { template: 'D' },
    e: { template: 'E', bg: 'warning' },
  },
  root: { v: [
    { h: ['a'] },
    { kind: 'group', name: 'outer', label: 'outer', direction: 'horizontal',
      children: ['b', { kind: 'group', name: 'inner', label: 'inner', children: ['d'] }, 'c', 'e'] },
  ] },
}`;

describe("candybar-render-ai7.9 — a group's toggle is a trigger", () => {
  test("closed it wears its address's tint; open it wears the state of the band its body is, and the body cells are that band's items", () => {
    const rt = build(GROUP_SRC);
    const { palette } = rt;
    rt.render();
    const toggle = "groups.outer";
    const tint = decorFor(palette, barAddress(rt, toggle)).hex;
    expect(rt.bgOf(toggle)).toBe(tint);
    expect(() => rt.bgOf("b")).toThrow(/did not render/);

    rt.clickWriting(toggle, toggle, "outer");
    rt.render();
    const hue = rt.hueOf(toggle);
    expect(rt.bgOf(toggle)).toBe(bandFor(palette, { hue, depth: 0 }).state.hex);
    for (const name of ["b", "groups.inner", "c"]) {
      expect([name, rt.bgOf(name)]).toEqual([name, rt.expectedTint(name)]);
    }
    expect(rt.fgOf("c")).toBe(textOn(palette, decorationFor(palette, regionOf(rt.root, palette, "c")).tint).hex);
    expect(rt.fgOf("b")).toBe(palette.get("error")!.hex);

    rt.clickWriting(toggle, toggle, DISCLOSURE_CLOSED);
    rt.render();
    expect(rt.bgOf(toggle)).toBe(tint);
  });

  test("a body cell's chosen text reads on the background it WEARS — an authored bg, not the tint", () => {
    const rt = build(GROUP_SRC);
    const { palette } = rt;
    rt.render();
    rt.clickWriting("groups.outer", "groups.outer", "outer");
    rt.render();
    const authored = palette.get("warning")!;
    expect(rt.bgOf("e")).toBe(authored.hex);
    expect(rt.fgOf("e")).toBe(textOn(palette, authored).hex);
    // The case is only a case because the two poles differ here.
    const tint = decorationFor(palette, regionOf(rt.root, palette, "e")).tint;
    expect(textOn(palette, authored).hex).not.toBe(textOn(palette, tint).hex);
    rt.dispose();
  });

  test("a group nested in a group's body opens the next depth", () => {
    const rt = build(GROUP_SRC);
    const { palette } = rt;
    rt.render();
    rt.clickWriting("groups.outer", "groups.outer", "outer");
    rt.render();
    expect(rt.bgOf("groups.inner")).toBe(rt.expectedTint("groups.inner"));
    rt.clickWriting("groups.inner", "groups.inner", "inner");
    rt.render();
    const hue = rt.hueOf("groups.outer");
    const band1 = bandFor(palette, { hue, depth: 1 });
    expect(rt.bgOf("groups.inner")).toBe(band1.state.hex);
    expect(rt.bgOf("d")).toBe(rt.expectedTint("d"));
    expect(rt.bgOf("d")).toBe(
      bandItemFor(palette, { hue, depth: 1 }, regionAddress(rt, "d")).hex,
    );
    rt.dispose();
  });
});

function barAddress(rt: ReturnType<typeof build>, name: string) {
  const region = regionOf(rt.root, rt.palette, name);
  if (region.kind !== "bar") throw new Error(`"${name}" is not on the bar`);
  return region.address;
}
