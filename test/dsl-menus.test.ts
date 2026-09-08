// [LAW:verifiable-goals] Menu acceptance through the real spine, loader and gate.
// The loader synthesizes the open-state var, cycle action and page cursor.

import { ownLinks } from "./helpers/ambient-chrome";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  deriveActionValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";
import { ConfigError } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import type { RichText } from "@promptctl/rich-js";
import { PRESET_FLOOR } from "../src/config/presets";
import type { CompiledNode } from "../src/dsl/node-registry";
import {
  bandFor,
  bandItemFor,
  decorEntryFor,
  DEFAULT_DISTRIBUTION,
  DISTRIBUTIONS,
  textOn,
  type Address,
} from "../src/themes/decor";

// The address of segment `name`, or throw.
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

const ALLOWED = new Set(listResolvablePaletteNames());

function opts() {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    charset: "unicode" as const,
    width: Number.POSITIVE_INFINITY,
  };
}

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  // Every bar also carries the settings menu's links.
  return ownLinks(urls);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function bgCodes(rendered: string): Set<string> {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[(?:[0-9;]*;)?48;2;(\d+;\d+;\d+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) out.add(m[1]!);
  return out;
}

function buildRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = getThemePalette("textual-dark"!);
  const sink = new Map<string, readonly RichText[]>();
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      basePalette,
      opts(),
      { perSegmentSink: sink },
    );
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const ctx: VerbContext = testVerbContext(sessionState);
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
  const clickToggle = (out: string, key: string, value: string): void => {
    const url = extractUrls(out).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no toggle writing ${key}=${value} rendered`);
    click(url);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return {
    config,
    compiled,
    store,
    sessionState,
    sink,
    palette: basePalette,
    render,
    click,
    clickToggle,
    dispose,
  };
}

// Identity is (segment + apply name); term.cols because paged=true reads a width.
const MENU_SRC = `{
  globals: {},
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
  },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
  },
  segments: {
    label: { template: 'PICK', bg: 'surface', fg: 'foreground' },
    themepicker: { template: '🎨 {{ menu "applyTheme" "▸" "▾" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['label', 'themepicker'] },
}`;

const TKEY = "menus.themepicker.applyTheme";
const PKEY = `${TKEY}.page`;

describe("menu synthesis (derived identity, reserved namespace)", () => {
  test("synthesizes state var + cycle action + page cursor keyed by (segment, apply); both gates derive", () => {
    const config = parseAndValidate("<test>", MENU_SRC, ALLOWED);
    expect(config.variables[TKEY]).toEqual({
      kind: "state",
      key: TKEY,
      default: "closed",
    });
    expect(config.actions[`${TKEY}.applyTheme`]).toEqual({
      set: TKEY,
      cycle: ["closed", "applyTheme"],
    });
    // A PAIR, so forgetting one half is unrepresentable.
    expect(config.variables[PKEY]).toEqual({
      kind: "state",
      key: PKEY,
      default: "0",
    });
    expect(config.actions[PKEY]).toEqual({ set: PKEY, int: true });
    const gates = deriveActionValidators(config);
    expect(gates.find((g) => g.key === TKEY)?.spec).toEqual({
      kind: "allow-list",
      allowed: ["closed", "applyTheme"],
    });
    expect(gates.find((g) => g.key === PKEY)?.spec).toEqual({ kind: "int" });
  });

  test("a user menus.* name is rejected even when NO menu is placed (unconditional reservation)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' }, 'menus.mine': { kind: 'literal', value: 'v' } },
      segments: { plain: { template: 'X', bg: 'surface', fg: 'foreground' } },
      root: { h: ['plain'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(
        /reserved "menus\." namespace/,
      );
    }
  });

  test('a {{ menu }} whose apply action is named "closed" is rejected (sentinel collision)', () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { closed: { set: 'theme', from: 'themes' } },
      segments: { s: { template: '{{ menu "closed" "▸" "▾" }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/named "closed"/);
    }
  });

  test("a {{ menu }} with a non-literal apply action is rejected (cannot gate at load)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' }, applyVar: { kind: 'literal', value: 'applyTheme' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      segments: { s: { template: '{{ menu .applyVar }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/not a string literal/);
    }
  });

  test("two menus whose names normalize to the same state key are rejected (lossy ident)", () => {
    // "a-b" and "a_b" normalize to one key: an unintended accordion.
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: {
        'a-b': { set: 'theme', from: 'themes' },
        'a_b': { set: 'style', from: 'styles' },
      },
      segments: { s: { template: 'S {{ menu "a-b" "▸" "▾" }} {{ menu "a_b" "▸" "▾" }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(
        /normalize to the same state key/,
      );
    }
  });

  test("a {{ menu }} with an empty apply name is rejected (member aliases absent sentinel)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { s: { template: '{{ menu "" "▸" "▾" }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/empty apply-action name/);
    }
  });

  test("a {{ menu }} referencing an unknown apply action is a LOAD error (not render-time)", () => {
    // Cross-ref must catch a missing action at load, not on open.
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { s: { template: '{{ menu "noSuchApply" "▸" "▾" }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(
        /unknown action "noSuchApply" \(in a picker or menu\)/,
      );
    }
  });

  test("a {{ menu }} with an empty accordion key is rejected (bare menus. key)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      segments: { s: { template: '{{ menu "applyTheme" "▸" "▾" (dict "key" "") }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/empty accordion key/);
    }
  });

  test("a {{ menu }} in a segment bg/fg/when field is rejected (template-only seam)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      segments: { s: { template: 'X', bg: '{{ menu "applyTheme" "▸" "▾" }}', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(
        /only valid in a segment's "template"/,
      );
    }
  });

  test("a {{ menu }} in a rows-form row's `when` is rejected (the fragment is lowered before the walk)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      segments: { s: { template: 'X', bg: 'surface', fg: 'foreground' } },
      root: { rows: { r: { h: ['s'], when: '{{ menu "applyTheme" "▸" "▾" }}' } } },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(
        /a layout node's "when" predicate uses \{\{ menu \}\}/,
      );
    }
  });

  test("a menu-bearing segment placed more than once is rejected (shared open-state)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      segments: { m: { template: 'M {{ menu "applyTheme" "▸" "▾" }}', bg: 'surface', fg: 'foreground' } },
      root: { v: [ { h: ['m'] }, { h: ['m'] } ] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(
        /placed in the layout more than once/,
      );
    }
  });

  test("a `{ rows }` fragment re-placing a menu host the inherited rows already place is rejected — counted over the tree that renders", () => {
    const src = `{ root: { rows: { extra: { h: ['charsetControl'] } } } }`;
    try {
      parseAndValidate("<test>", src, ALLOWED, DEFAULT_DSL_CONFIG);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(
        /"charsetControl" hosts a \{\{ menu \}\} and is placed in the layout more than once/,
      );
    }
  });

  test("a preset's `{ rows }` fragment re-placing a menu host the inherited rows already place is rejected at the preset", () => {
    const src = `{ presets: { wide: { root: { rows: { extra: { h: ['charsetControl'] } } } } } }`;
    try {
      parseAndValidate("<test>", src, ALLOWED, DEFAULT_DSL_CONFIG);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const issue = (e as ConfigError).issues.find((i) =>
        /"charsetControl" hosts a \{\{ menu \}\} and is placed in the layout more than once/.test(i.message),
      )!;
      expect(issue.path).toBe("presets.wide.root");
    }
  });

  test("a {{ menu }} inside a helper is rejected at load (no per-segment identity)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      helpers: { mkMenu: '{{ menu "applyTheme" "▸" "▾" }}' },
      segments: { s: { template: '{{ template "mkMenu" . }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(
        /helper "mkMenu" uses \{\{ menu \}\}/,
      );
    }
  });
});

// [LAW:no-silent-failure] Removed spellings must fail AT LOAD naming the new form.
const srcFor = (segTemplate: string, extraVars = ""): string => `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' }, 'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 }${extraVars} },
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: { s: { template: '${segTemplate}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
const load =
  (segTemplate: string, extraVars = ""): (() => void) =>
  () =>
    parseAndValidate("<test>", srcFor(segTemplate, extraVars), ALLOWED);

describe("bn5.6 — old spellings and bad option dicts are migration-pointing LOAD errors", () => {

  test("the full old positional form fails load naming the new form (acceptance)", () => {
    try {
      load('{{ menu "applyTheme" "themePage" false true }}')();
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toMatch(/positional tail .* was removed/);
      expect(msg).toMatch(/\{\{ menu "applyTheme" "▸" "▾" \}\}/);
      expect(msg).toMatch(/dict "closeOnPick"/);
    }
  });

  // Authored text, so the display-less form fails at LOAD rather than inventing one.
  test("no display fails load naming the authored form (acceptance)", () => {
    try {
      load('{{ menu "applyTheme" }}')();
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toMatch(/needs a display/);
      expect(msg).toMatch(/\{\{ menu "applyTheme" "▸" "▾" \}\}/);
    }
  });

  // [LAW:no-silent-failure] The one ambiguous shape; rejecting it needs a
  // heuristic that could refuse a valid config.
  test("a two-argument menu binds a static display (the ancient page form is visible, not silent)", () => {
    expect(load('{{ menu "applyTheme" "themePage" }}')).not.toThrow();
    // [LAW:behavior-not-structure] A load-only check would pass regardless.
    const rt = buildRuntime(srcFor('{{ menu "applyTheme" "themePage" }}'));
    expect(stripAnsi(rt.render())).toContain("themePage");
    rt.dispose();
  });

  test("an unknown option name fails load (transposition guard)", () => {
    expect(
      load('{{ menu "applyTheme" "▸" "▾" (dict "closeonpick" true) }}'),
    ).toThrow(/unknown \{\{ menu \}\} option "closeonpick"/);
  });

  test("a mistyped option value fails load (bool where string / string where bool)", () => {
    expect(
      load('{{ menu "applyTheme" "▸" "▾" (dict "paged" "yes") }}'),
    ).toThrow(/"paged" must be a boolean/);
    expect(load('{{ menu "applyTheme" "▸" "▾" (dict "key" true) }}')).toThrow(
      /"key" must be a string/,
    );
  });

  test("a dynamic dict entry fails load (cannot gate at load)", () => {
    expect(
      load(
        '{{ menu "applyTheme" "▸" "▾" (dict "key" .someVar) }}',
        ", someVar: { kind: 'literal', value: 'k' }",
      ),
    ).toThrow(/not fully literal/);
  });
});

// [LAW:one-source-of-truth] The loader splits the tail on EXPRS and the renderer
// on VALUES; only sites where the two readings PROVABLY coincide are admitted.
describe("the options dict and the trigger displays cannot be confused", () => {
  test("a non-literal LAST argument fails load when both readings are legal", () => {
    try {
      load('{{ menu "applyTheme" "▸" .session.id }}')();
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toMatch(/neither a literal nor a literal \(dict …\)/);
      expect(msg).toMatch(/read as 2 displays or as 1 plus options/);
      expect(msg).toMatch(/\(dict\) \}\}/);
    }
  });

  test("an explicit trailing (dict …) disambiguates, so dynamic displays stay legal", () => {
    // Spelling out the options slot makes the last expr provably the dict.
    expect(
      load('{{ menu "applyTheme" (printf "◂%s" "a") (printf "▸%s" "b") (dict) }}'),
    ).not.toThrow();
  });

  test("a non-literal SOLE display loads — its other reading throws, so it is not silent", () => {
    // Read as options this is zero displays, already illegal, so it fails loud.
    expect(load('{{ menu "applyTheme" .session.id }}')).not.toThrow();
  });

  test("a non-string display fails LOUDLY at render, naming its position", () => {
    // This throw is all that stands between an author and a dropped trigger.
    const rt = buildRuntime(srcFor('{{ menu "applyTheme" (list "x") "▾" }}'));
    const out = stripAnsi(rt.render());
    expect(out).toContain("display #1 is not text");
    expect(out).toContain('["x"]');
    rt.dispose();
  });
});

describe("toggle round trip + drop stacking", () => {
  test("closed: glyph ▸ inline, no body, single line, neighbor present", () => {
    const { render, dispose } = buildRuntime(MENU_SRC);
    const out = stripAnsi(render());
    expect(out).toContain("🎨 ▸");
    expect(out).toContain("PICK");
    expect(out).not.toContain("✕");
    expect(out.split("\n")).toHaveLength(1);
    dispose();
  });

  test("click opens: ▾ + body dropped BELOW the row; row 0 keeps the neighbor", () => {
    const { render, clickToggle, sessionState, dispose } =
      buildRuntime(MENU_SRC);
    clickToggle(render(), TKEY, "applyTheme");
    expect(sessionState.get("s1", TKEY)).toBe("applyTheme");
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("PICK");
    expect(lines[0]).toContain("🎨 ▾");
    expect(lines[0]).not.toContain("✕");
    expect(lines[1]).toContain("✕");
    clickToggle(render(), TKEY, "closed");
    expect(stripAnsi(render()).split("\n")).toHaveLength(1);
    dispose();
  });

  // [LAW:verifiable-goals] Expected bytes come from the model, not from lightening.
  test("the open trigger wears the state of the band it opens; its items are that band's", () => {
    const { render, sink, compiled, palette, clickToggle, dispose } =
      buildRuntime(MENU_SRC);
    render();
    clickToggle(render(), TKEY, "applyTheme");
    render();
    const address = addressOf(compiled.roots.get(PRESET_FLOOR)!, "themepicker");
    const disclosure = {
      hue: decorEntryFor(address).hue,
      depth: 0,
    };
    const band = bandFor(palette, disclosure);
    const cells = sink.get("themepicker")!;
    const trigger = cells[0]!;
    expect(trigger.style?.bgcolor?.value?.hex).toBe(band.state.hex);
    expect(trigger.style?.color?.value?.hex).toBe(textOn(palette, band.state).hex);
    // Placed by (index, count) over the WHOLE domain, in insertion order.
    const body = cells[1]!;
    expect(body.style?.bgcolor?.value?.hex).toBe(band.plane.hex);
    const options = [...ALLOWED];
    const spans = body.spans.filter(
      (s) => typeof s.style !== "string" && s.style.link !== undefined,
    );
    const optionSpans = spans.filter((s) => options.includes(body.plain.slice(s.start, s.end)));
    expect(optionSpans.length).toBeGreaterThan(1);
    for (const span of optionSpans) {
      const index = options.indexOf(body.plain.slice(span.start, span.end));
      const style = span.style;
      if (typeof style === "string") throw new Error("span style is a name, not a Style");
      expect(style.bgcolor?.value?.hex).toBe(
        bandItemFor(palette, disclosure, [
          { index, count: options.length, distribution: DISTRIBUTIONS[DEFAULT_DISTRIBUTION] },
        ]).hex,
      );
    }
    dispose();
  });

  // A band is one step on ITS trigger's address, invisible to every other segment.
  test("opening a menu changes the colour of no other cell", () => {
    const { render, sink, clickToggle, dispose } = buildRuntime(MENU_SRC);
    const snapshot = (): Map<string, string> => {
      render();
      return new Map(
        [...sink.entries()].map(([name, cells]) => [
          name,
          cells.map((c) => `${c.plain}|${c.style?.bgcolor?.value?.hex}|${c.style?.color?.value?.hex}`).join("\n"),
        ]),
      );
    };
    const closed = snapshot();
    clickToggle(render(), TKEY, "applyTheme");
    const open = snapshot();
    for (const [name, bytes] of closed) {
      if (name === "themepicker") continue;
      expect(open.get(name)).toBe(bytes);
    }
    expect(open.get("themepicker")).not.toBe(closed.get("themepicker"));
    dispose();
  });

  // [LAW:verifiable-goals] One atomic write toggles AND resets the page cursor.
  test("disclosure click resets the synthesized page cursor to 0 in the same atomic write", () => {
    const { render, dispose } = buildRuntime(MENU_SRC);
    const url = extractUrls(render()).find((u) =>
      effectsOf(u).some((e) => e.args[1] === TKEY),
    );
    if (!url) throw new Error("no disclosure toggle rendered");
    const eff = effectsOf(url)[0]!;
    // [sessionId, openStateKey, successor, pageKey, "0"]
    expect(eff.args.slice(1)).toEqual([TKEY, "applyTheme", PKEY, "0"]);
    dispose();
  });

  // The ✕ closes as ▾ does, not the picker's page=-1 idiom, which cannot.
  test("the dropped body's ✕ closes the disclosure (and resets the page)", () => {
    const { render, click, clickToggle, sessionState, dispose } =
      buildRuntime(MENU_SRC);
    clickToggle(render(), TKEY, "applyTheme");
    const open = render();
    expect(stripAnsi(open).split("\n")).toHaveLength(2);
    const closeUrl = extractUrls(open).find((u) =>
      effectsOf(u).some(
        (e) =>
          e.args[1] === TKEY &&
          e.args[2] === "closed" &&
          e.args[3] === PKEY &&
          e.args[4] === "0",
      ),
    );
    if (!closeUrl) throw new Error("no close write rendered");
    click(closeUrl);
    expect(sessionState.get("s1", TKEY)).toBe("closed");
    expect(sessionState.get("s1", PKEY)).toBe("0");
    expect(stripAnsi(render()).split("\n")).toHaveLength(1);
    dispose();
  });

  // closeOnPick folds the same close pair into the option's apply write.
  test('(dict "closeOnPick" true): picking an option applies it AND closes the menu', () => {
    const src = MENU_SRC.replace(
      '{{ menu "applyTheme" "▸" "▾" }}',
      '{{ menu "applyTheme" "▸" "▾" (dict "closeOnPick" true) }}',
    );
    const { render, click, clickToggle, sessionState, dispose } =
      buildRuntime(src);
    clickToggle(render(), TKEY, "applyTheme");
    const open = render();
    const pickUrl = extractUrls(open).find((u) =>
      effectsOf(u).some((e) => e.args[1] === "theme" && e.args[3] === TKEY),
    );
    if (!pickUrl) throw new Error("no pick+close option write rendered");
    const eff = effectsOf(pickUrl)[0]!;
    // [sessionId, themeKey, option, stateKey, "closed", pageKey, "0"]
    expect(eff.args.slice(3)).toEqual([TKEY, "closed", PKEY, "0"]);
    click(pickUrl);
    expect(sessionState.get("s1", TKEY)).toBe("closed");
    expect(sessionState.get("s1", "theme")).toBe(eff.args[2]);
    expect(stripAnsi(render()).split("\n")).toHaveLength(1);
    dispose();
  });
});

// Two menus, neither naming a key ⇒ INDEPENDENT.
const INDEPENDENT_SRC = `{
  globals: {},
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
  },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    applyStyle: { set: 'style', from: 'styles' },
  },
  segments: {
    themeMenu: { template: 'T {{ menu "applyTheme" "▸" "▾" }}', bg: 'surface', fg: 'foreground' },
    styleMenu: { template: 'S {{ menu "applyStyle" "▸" "▾" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['themeMenu', 'styleMenu'] },
}`;

describe("independent default (no shared key)", () => {
  test("two menus have distinct keys (and page cursors); both can be open at once", () => {
    const { config, render, clickToggle, dispose } =
      buildRuntime(INDEPENDENT_SRC);
    expect(config.variables["menus.themeMenu.applyTheme"]).toBeDefined();
    expect(config.variables["menus.styleMenu.applyStyle"]).toBeDefined();
    expect(config.variables["menus.themeMenu.applyTheme.page"]).toBeDefined();
    expect(config.variables["menus.styleMenu.applyStyle.page"]).toBeDefined();

    clickToggle(render(), "menus.themeMenu.applyTheme", "applyTheme");
    let out = stripAnsi(render());
    expect(out).toContain("T ▾");
    expect(out).toContain("S ▸");
    clickToggle(render(), "menus.styleMenu.applyStyle", "applyStyle");
    out = stripAnsi(render());
    expect(out).toContain("T ▾");
    expect(out).toContain("S ▾");
    expect(stripAnsi(render()).split("\n").length).toBeGreaterThanOrEqual(3);
    dispose();
  });
});

// Two menus sharing one key ⇒ ACCORDION.
const ACCORDION_SRC = `{
  globals: {},
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
  },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    applyStyle: { set: 'style', from: 'styles' },
  },
  segments: {
    themeMenu: { template: 'T {{ menu "applyTheme" "▸" "▾" (dict "key" "pickers") }}', bg: 'surface', fg: 'foreground' },
    styleMenu: { template: 'S {{ menu "applyStyle" "▸" "▾" (dict "key" "pickers") }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['themeMenu', 'styleMenu'] },
}`;

describe("opt-in accordion (shared key, one open at a time)", () => {
  test("both menus share the key; the gate unions members; ONE shared page cursor; opening one closes the other", () => {
    const { config, render, clickToggle, dispose } =
      buildRuntime(ACCORDION_SRC);
    expect(config.actions["menus.pickers.applyTheme"]).toEqual({
      set: "menus.pickers",
      cycle: ["closed", "applyTheme"],
    });
    expect(config.actions["menus.pickers.applyStyle"]).toEqual({
      set: "menus.pickers",
      cycle: ["closed", "applyStyle"],
    });
    const gate = deriveActionValidators(config).find(
      (g) => g.key === "menus.pickers",
    );
    expect(gate?.spec).toEqual({
      kind: "allow-list",
      allowed: ["closed", "applyTheme", "applyStyle"],
    });
    // The accordion holds at most one open body, so one cursor is exact.
    expect(config.variables["menus.pickers.page"]).toEqual({
      kind: "state",
      key: "menus.pickers.page",
      default: "0",
    });

    clickToggle(render(), "menus.pickers", "applyTheme");
    let out = stripAnsi(render());
    expect(out).toContain("T ▾");
    expect(out).toContain("S ▸");
    clickToggle(render(), "menus.pickers", "applyStyle");
    out = stripAnsi(render());
    expect(out).toContain("T ▸");
    expect(out).toContain("S ▾");
    dispose();
  });

  test("two menus sharing a key with the SAME apply action are rejected (identity clash)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      segments: {
        a: { template: 'A {{ menu "applyTheme" "▸" "▾" (dict "key" "k") }}', bg: 'surface', fg: 'foreground' },
        b: { template: 'B {{ menu "applyTheme" "▸" "▾" (dict "key" "k") }}', bg: 'surface', fg: 'foreground' },
      },
      root: { h: ['a', 'b'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/same identity/);
    }
  });
});

// Three menus in ONE segment, with content between and after.
const TESTER_SRC = `{
  globals: {},
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
  },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    applyStyle: { set: 'style', from: 'styles' },
    applyTheme2: { set: 'theme', from: 'themes' },
  },
  segments: {
    tester: { template: 'TEST {{ menu "applyTheme" "▸" "▾" }} | {{ menu "applyStyle" "▸" "▾" }} | {{ menu "applyTheme2" "▸" "▾" }} END', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['tester'] },
}`;

describe('the "theme tester" — N menus in one segment', () => {
  test("each menu is a DISTINCT addressable disclosure (no identity collision)", () => {
    const config = parseAndValidate("<test>", TESTER_SRC, ALLOWED);
    expect(config.variables["menus.tester.applyTheme"]).toBeDefined();
    expect(config.variables["menus.tester.applyStyle"]).toBeDefined();
    expect(config.variables["menus.tester.applyTheme2"]).toBeDefined();
    // Restricted to this segment: every bar carries others in the same namespace.
    const menuKeys = Object.keys(config.variables).filter((k) =>
      k.startsWith("menus.tester."),
    );
    expect(menuKeys).toHaveLength(6);
  });

  test("closed: all three glyphs inline with the separators + END on one row", () => {
    const { render, dispose } = buildRuntime(TESTER_SRC);
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TEST ▸ | ▸ | ▸ END");
    dispose();
  });

  test("a mid-segment menu keeps content AFTER it on row 0; its body drops below", () => {
    const { render, clickToggle, dispose } = buildRuntime(TESTER_SRC);
    clickToggle(render(), "menus.tester.applyTheme", "applyTheme");
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("TEST ▾ | ▸ | ▸ END");
    expect(lines[0]).not.toContain("✕");
    expect(lines[1]).toContain("✕");
    dispose();
  });

  test("all three open independently: three bodies stack below one inline row", () => {
    const { render, clickToggle, dispose } = buildRuntime(TESTER_SRC);
    clickToggle(render(), "menus.tester.applyTheme", "applyTheme");
    clickToggle(render(), "menus.tester.applyStyle", "applyStyle");
    clickToggle(render(), "menus.tester.applyTheme2", "applyTheme2");
    const lines = stripAnsi(render()).split("\n");
    expect(lines[0]).toContain("TEST ▾ | ▾ | ▾ END");
    expect(lines).toHaveLength(4);
    dispose();
  });
});

describe("compose substrate (drops stack, single-line rows unchanged)", () => {
  const TWOLINE_SRC = `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    segments: {
      one: { template: 'ONE', bg: 'surface', fg: 'foreground' },
      two: { template: 'TOP{{ "\\\\n" }}DROP', bg: 'surface', fg: 'foreground' },
    },
    root: { h: ['one', 'two'] },
  }`;

  test("a multi-line child drops its overflow full-width below row 0", () => {
    const { render, dispose } = buildRuntime(TWOLINE_SRC);
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ONE");
    expect(lines[0]).toContain("TOP");
    expect(lines[0]).not.toContain("DROP");
    expect(lines[1]).toContain("DROP");
    dispose();
  });

  test("an all-single-line horizontal row stays one line with every segment", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: {
        a: { template: 'AAA', bg: 'surface', fg: 'foreground' },
        b: { template: 'BBB', bg: 'surface', fg: 'foreground' },
        c: { template: 'CCC', bg: 'surface', fg: 'foreground' },
      },
      root: { h: ['a', 'b', 'c'] },
    }`;
    const { render, dispose } = buildRuntime(src);
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("AAA");
    expect(lines[0]).toContain("BBB");
    expect(lines[0]).toContain("CCC");
    dispose();
  });
});

// [LAW:verifiable-goals] A menu over a NEW field needs only config data.

describe("candybar-config-engine-71o.5 — a brand-new field gets a {{ menu }} via inline domain alone", () => {
  // A field no built-in segment, action or domain registry knows about.
  const SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
      soundEffects: { kind: 'state', key: 'sound-effects', default: 'chime' },
    },
    actions: {
      applySound: { set: 'sound-effects', from: ['chime', 'buzz', 'silent'] },
    },
    segments: {
      soundControl: {
        template: '\u{1F50A} {{ .soundEffects }} {{ menu "applySound" "▸" "▾" }}',
        bg: 'surface', fg: 'foreground',
      },
    },
    root: 'soundControl',
  }`;

  test("the picker renders one option per inline domain member, once opened", () => {
    const { render, click, dispose } = buildRuntime(SRC);
    const closed = render();
    expect(closed).not.toContain("buzz");
    expect(closed).not.toContain("silent");

    const toggleUrl = extractUrls(closed).find((u) =>
      effectsOf(u).some((e) => e.args[2] === "applySound"),
    );
    expect(toggleUrl).toBeDefined();
    click(toggleUrl!);

    const opened = render();
    for (const member of ["chime", "buzz", "silent"]) {
      expect(opened).toContain(member);
    }
    dispose();
  });

  test("clicking an option mutates the field through the real gate — the domain's own allow-list, derived with zero engine edits", () => {
    const { render, click, sessionState, dispose } = buildRuntime(SRC);
    const toggleUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some((e) => e.args[2] === "applySound"),
    );
    expect(toggleUrl).toBeDefined();
    click(toggleUrl!);

    const opened = render();
    const buzzUrl = extractUrls(opened).find((u) =>
      effectsOf(u).some((e) => e.verb === "set-state" && e.args[2] === "buzz"),
    );
    expect(buzzUrl).toBeDefined();
    click(buzzUrl!);

    expect(sessionState.get("s1", "sound-effects")).toBe("buzz");

    // The gate is the inline domain itself: a REAL derived allow-list.
    const rejected = validateStateWrite("sound-effects", "explosion");
    expect(rejected.ok).toBe(false);
    dispose();
  });
});

// [LAW:one-source-of-truth][LAW:behavior-not-structure] One glyph policy across
// both kinds, asserted as shared BEHAVIOR, not via the shared function.
describe("aok.4 — group and menu resolve their trigger display by one rule", () => {
  const BOTH = (groupDisplays: string, menuDisplays: string) => `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    },
    actions: { applyTheme: { set: 'theme', from: 'themes' } },
    segments: {
      body: { template: 'BODY', bg: 'surface', fg: 'foreground' },
      picker: { template: 'P {{ menu "applyTheme" ${menuDisplays} }}', bg: 'surface', fg: 'foreground' },
    },
    root: { v: [
      { kind: 'group', name: 'grp', label: 'G', children: [{ kind: 'segment', name: 'body' }] },
      { kind: 'segment', name: 'picker' },
    ] },
  }`;

  test("per-state displays: both swap when opened", () => {
    const { render, clickToggle, dispose } = buildRuntime(BOTH("", `"▸" "▾"`));
    const closed = stripAnsi(render());
    expect(closed).toContain("G ▸");
    expect(closed).toContain("P ▸");

    clickToggle(render(), "groups.grp", "grp");
    clickToggle(render(), "menus.picker.applyTheme", "applyTheme");
    const open = stripAnsi(render());
    expect(open).toContain("G ▾");
    expect(open).toContain("P ▾");
    dispose();
  });

  // One display, shown in both states — the form edit chrome's `+` uses.
  test("one static display: the menu shows it in both states", () => {
    const { render, clickToggle, dispose } = buildRuntime(BOTH("", `"+"`));
    const closed = stripAnsi(render()).split("\n");
    expect(closed.some((l) => l.includes("P +"))).toBe(true);

    clickToggle(render(), "menus.picker.applyTheme", "applyTheme");
    const open = stripAnsi(render()).split("\n");
    const row = open.findIndex((l) => l.includes("P +"));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(open.length).toBe(closed.length + 1);
    expect(open[row + 1]).toBeDefined();
    dispose();
  });

  // A menu's display count is statically known, so three is a load error.
  test("three displays on a two-state disclosure is a load error", () => {
    expect(() =>
      parseAndValidate("<test>", BOTH("", `"a" "b" "c"`), ALLOWED),
    ).toThrow(/cycles 2 members; bind one display per member \(2\)/);
  });
});

// A menu's band places options by the SAME `distribution` a container carries.
describe("a menu's `distribution` option places its band", () => {
  const WITH = (dictEntry: string): string =>
    MENU_SRC.replace(
      '{{ menu "applyTheme" "▸" "▾" }}',
      `{{ menu "applyTheme" "▸" "▾" (dict ${dictEntry}) }}`,
    );

  test("`monotonic` places every option cell by monotonic over the whole domain", () => {
    const { render, sink, compiled, palette, clickToggle, dispose } = buildRuntime(
      WITH('"distribution" "monotonic"'),
    );
    render();
    clickToggle(render(), TKEY, "applyTheme");
    render();
    const address = addressOf(compiled.roots.get(PRESET_FLOOR)!, "themepicker");
    const disclosure = { hue: decorEntryFor(address).hue, depth: 0 };
    const body = sink.get("themepicker")![1]!;
    const options = [...ALLOWED];
    const optionSpans = body.spans.filter(
      (s) =>
        typeof s.style !== "string" &&
        s.style.link !== undefined &&
        options.includes(body.plain.slice(s.start, s.end)),
    );
    expect(optionSpans.length).toBeGreaterThan(1);
    let differsFromDefault = 0;
    for (const span of optionSpans) {
      const index = options.indexOf(body.plain.slice(span.start, span.end));
      const style = span.style;
      if (typeof style === "string") throw new Error("span style is a name, not a Style");
      const step = { index, count: options.length };
      expect(style.bgcolor?.value?.hex).toBe(
        bandItemFor(palette, disclosure, [{ ...step, distribution: DISTRIBUTIONS.monotonic }]).hex,
      );
      if (
        style.bgcolor?.value?.hex !==
        bandItemFor(palette, disclosure, [
          { ...step, distribution: DISTRIBUTIONS[DEFAULT_DISTRIBUTION] },
        ]).hex
      )
        differsFromDefault++;
    }
    expect(differsFromDefault).toBeGreaterThan(0);
    dispose();
  });

  test("an unknown distribution name is a load error naming the five", () => {
    expect(() => parseAndValidate("<test>", WITH('"distribution" "spiral"'), ALLOWED)).toThrow(
      /"distribution" must be one of: van-der-corput, golden-angle, ends-interleaved, monotonic, uniform; got "spiral"/,
    );
  });

  test("the unknown-option error lists `distribution` in the vocabulary", () => {
    expect(() => parseAndValidate("<test>", WITH('"distributon" "uniform"'), ALLOWED)).toThrow(
      /unknown \{\{ menu \}\} option "distributon".*"distribution" \(one of "van-der-corput"/,
    );
  });
});
