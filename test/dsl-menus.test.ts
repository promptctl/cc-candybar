// [LAW:verifiable-goals] Self-contained menu acceptance, driven through the real
// spine (registerDslConfig + renderDsl), the real loader (parse → validate → menu
// synthesis), and the real set-state gate — never a parallel rig. Covers the
// pdu.5/.7/.9 redesign (drop-channel bodies, name-derived identity) plus the
// bn5.6 surface: `{{ menu "apply" }}` is the COMPLETE common case — the loader
// synthesizes the open-state var + cycle action AND the page cursor (state var +
// int action) under the reserved `menus.` namespace — and rare knobs are ONE
// trailing `(dict …)` (closeOnPick / paged / key). The removed positional tail
// fails at load with a migration-pointing error.
//
//   1. A `{{ menu }}` SYNTHESIZES a state var + cycle action + page cursor under
//      the reserved `menus.` namespace, identity = (segment + apply name); both
//      gates derive through the one path. No author-named key (independent) by
//      default, no hand-declared page var/action ever.
//   2. Toggle round trip: closed renders ▸ and no body; the click writes the
//      member; the next render shows ▾ + the picker body dropped BELOW the row;
//      a second click closes; the body's ✕ closes too (disclosure back to
//      "closed" + page reset, the same coupled write the toggle promises).
//   3. Independent default: two menus (no key) are not mutually exclusive — both
//      can be open at once. Opt-in shared key ((dict "key" …)): an accordion.
//   4. N menus in ONE segment (the "theme tester"): each is a distinct,
//      addressable disclosure; mid-segment menus keep content after them inline
//      on row 0; all bodies stack below the row.
//   5. Old spellings (positional page/bools/key) and malformed option dicts are
//      LOAD errors naming the new form — never silently reinterpreted.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
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
import { effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts() {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
    width: Number.POSITIVE_INFINITY,
  };
}

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

// The distinct truecolor background SGR codes present in a rendered string —
// used to prove the focus tint added a NEW background (the lightened surface).
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
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      basePalette,
      opts(),
    );
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const ctx: VerbContext = { sessionState, dlog: () => {} };
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
  return { config, store, sessionState, render, click, clickToggle, dispose };
}

// A theme picker menu beside a plain label, in one horizontal row. Identity is
// (segment "themepicker" + apply "applyTheme"), independent ⇒ key
// `menus.themepicker.applyTheme`, member `applyTheme`. The apply action is the
// WHOLE declaration — no page var/action anywhere (bn5.6 synthesizes both).
// term.cols is declared because the default paged=true reads the live width
// (the bundled default declares it for real configs; bare fixtures declare it
// themselves, exactly like the pagination harness).
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
    themepicker: { template: '🎨 {{ menu "applyTheme" }}', bg: 'surface', fg: 'foreground' },
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
    // bn5.6: the page cursor is synthesized as a PAIR — the state var the
    // renderer reads the live page through AND the int action the wire gate
    // derives from. Forgetting one half (the silent page-0 freeze) is now
    // unrepresentable: the author declares neither.
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
      expect((e as ConfigError).message).toMatch(/reserved "menus\." namespace/);
    }
  });

  test('a {{ menu }} whose apply action is named "closed" is rejected (sentinel collision)', () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { closed: { set: 'theme', from: 'themes' } },
      segments: { s: { template: '{{ menu "closed" }}', bg: 'surface', fg: 'foreground' } },
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
    // segment "s" with apply actions "a-b" and "a_b" both normalize to
    // menus.s.a_b; without the collision guard they would silently share open
    // state (an unintended accordion). It must be a loud load error.
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: {
        'a-b': { set: 'theme', from: 'themes' },
        'a_b': { set: 'style', from: 'styles' },
      },
      segments: { s: { template: 'S {{ menu "a-b" }} {{ menu "a_b" }}', bg: 'surface', fg: 'foreground' } },
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
      segments: { s: { template: '{{ menu "" }}', bg: 'surface', fg: 'foreground' } },
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
    // The menu binds its apply action like a picker; cross-ref must catch a
    // missing action at load, not defer to renderPicker.requireKind on open.
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { s: { template: '{{ menu "noSuchApply" }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/unknown action "noSuchApply" \(in a picker or menu\)/);
    }
  });

  test("a {{ menu }} with an empty accordion key is rejected (bare menus. key)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      segments: { s: { template: '{{ menu "applyTheme" (dict "key" "") }}', bg: 'surface', fg: 'foreground' } },
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
      segments: { s: { template: 'X', bg: '{{ menu "applyTheme" }}', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/only valid in a segment's "template"/);
    }
  });

  test("a menu-bearing segment placed more than once is rejected (shared open-state)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      segments: { m: { template: 'M {{ menu "applyTheme" }}', bg: 'surface', fg: 'foreground' } },
      root: { v: [ { h: ['m'] }, { h: ['m'] } ] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/placed in the layout more than once/);
    }
  });

  test("a {{ menu }} inside a helper is rejected at load (no per-segment identity)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' } },
      helpers: { mkMenu: '{{ menu "applyTheme" }}' },
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

// [LAW:no-silent-failure] The removed spellings and malformed option dicts must
// fail AT LOAD with text naming the new form — a blind authoring agent's only
// channel. A silently reinterpreted tail (e.g. the old page-action string read
// as an option) would be the exact failure class bn5.6 exists to kill.
describe("bn5.6 — old spellings and bad option dicts are migration-pointing LOAD errors", () => {
  const load = (segTemplate: string, extraVars = ""): (() => void) => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' }${extraVars} },
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: { s: { template: '${segTemplate}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    return () => parseAndValidate("<test>", src, ALLOWED);
  };

  test("the full old positional form fails load naming the new form (acceptance)", () => {
    try {
      load('{{ menu "applyTheme" "themePage" false true }}')();
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toMatch(/positional tail .* was removed/);
      expect(msg).toMatch(/\{\{ menu "applyTheme" \}\}/); // the new form, named
      expect(msg).toMatch(/dict "closeOnPick"/); // …and the options spelling
    }
  });

  test("a bare page-action second string arg fails load (never reinterpreted)", () => {
    expect(load('{{ menu "applyTheme" "themePage" }}')).toThrow(
      /positional tail .* was removed/,
    );
  });

  test("an unknown option name fails load (transposition guard)", () => {
    expect(load('{{ menu "applyTheme" (dict "closeonpick" true) }}')).toThrow(
      /unknown \{\{ menu \}\} option "closeonpick"/,
    );
  });

  test("a mistyped option value fails load (bool where string / string where bool)", () => {
    expect(load('{{ menu "applyTheme" (dict "paged" "yes") }}')).toThrow(
      /"paged" must be a boolean/,
    );
    expect(load('{{ menu "applyTheme" (dict "key" true) }}')).toThrow(
      /"key" must be a string/,
    );
  });

  test("a dynamic dict entry fails load (cannot gate at load)", () => {
    expect(
      load(
        '{{ menu "applyTheme" (dict "key" .someVar) }}',
        ", someVar: { kind: 'literal', value: 'k' }",
      ),
    ).toThrow(/not fully literal/);
  });
});

describe("toggle round trip + drop stacking", () => {
  test("closed: glyph ▸ inline, no body, single line, neighbor present", () => {
    const { render, dispose } = buildRuntime(MENU_SRC);
    const out = stripAnsi(render());
    expect(out).toContain("🎨 ▸");
    expect(out).toContain("PICK"); // neighbor on the same row
    expect(out).not.toContain("✕"); // picker body (its ✕ affordance) absent
    expect(out.split("\n")).toHaveLength(1); // no spurious blank line
    dispose();
  });

  test("click opens: ▾ + body dropped BELOW the row; row 0 keeps the neighbor", () => {
    const { render, clickToggle, sessionState, dispose } = buildRuntime(MENU_SRC);
    clickToggle(render(), TKEY, "applyTheme");
    expect(sessionState.get("s1", TKEY)).toBe("applyTheme");
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(2); // row 0 + the dropped body
    expect(lines[0]).toContain("PICK"); // neighbor unmoved on row 0
    expect(lines[0]).toContain("🎨 ▾"); // disclosure flipped, still inline
    expect(lines[0]).not.toContain("✕"); // body is NOT zipped onto row 0
    expect(lines[1]).toContain("✕"); // body dropped onto its own full-width line
    // second click closes
    clickToggle(render(), TKEY, "closed");
    expect(stripAnsi(render()).split("\n")).toHaveLength(1);
    dispose();
  });

  test("the open menu's segment is focus-tinted (a new background appears)", () => {
    const { render, clickToggle, dispose } = buildRuntime(MENU_SRC);
    const closedBgs = bgCodes(render());
    clickToggle(render(), TKEY, "applyTheme");
    const openBgs = bgCodes(render());
    const added = [...openBgs].filter((c) => !closedBgs.has(c));
    expect(added.length).toBeGreaterThan(0);
    dispose();
  });

  // [LAW:verifiable-goals] The pagination-reset contract: the disclosure click is
  // ONE atomic set-state that toggles the open-state AND resets the SYNTHESIZED
  // page cursor to page 0 — so a reopened menu is never stranded on a stale page
  // left by ←/→ before the last close. The page key is derived from identity
  // (menuPageKey), never from a page-action argument.
  test("disclosure click resets the synthesized page cursor to 0 in the same atomic write", () => {
    const { render, dispose } = buildRuntime(MENU_SRC);
    const url = extractUrls(render()).find((u) =>
      effectsOf(u).some((e) => e.args[1] === TKEY),
    );
    if (!url) throw new Error("no disclosure toggle rendered");
    const eff = effectsOf(url)[0]!;
    // [sessionId, openStateKey, successor, pageKey, "0"] — open-state + page reset
    // in one batch. Both keys are independently gated; the batch passes one gate.
    expect(eff.args.slice(1)).toEqual([TKEY, "applyTheme", PKEY, "0"]);
    dispose();
  });

  // The body's ✕ delivers the SAME close the ▾ glyph promises: disclosure back
  // to "closed" + page reset, one atomic write — not the standalone picker's
  // page=-1 idiom (which cannot close a disclosure-keyed menu).
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
    expect(stripAnsi(render()).split("\n")).toHaveLength(1); // body gone
    dispose();
  });

  // closeOnPick folds the SAME close pair into the option's apply write — one
  // atomic pick+close, exercised through the dict option end-to-end.
  test('(dict "closeOnPick" true): picking an option applies it AND closes the menu', () => {
    const src = MENU_SRC.replace(
      '{{ menu "applyTheme" }}',
      '{{ menu "applyTheme" (dict "closeOnPick" true) }}',
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
    expect(stripAnsi(render()).split("\n")).toHaveLength(1); // closed on pick
    dispose();
  });
});

// Two menus in ONE row, neither naming a key ⇒ INDEPENDENT.
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
    themeMenu: { template: 'T {{ menu "applyTheme" }}', bg: 'surface', fg: 'foreground' },
    styleMenu: { template: 'S {{ menu "applyStyle" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['themeMenu', 'styleMenu'] },
}`;

describe("independent default (no shared key)", () => {
  test("two menus have distinct keys (and page cursors); both can be open at once", () => {
    const { config, render, clickToggle, dispose } =
      buildRuntime(INDEPENDENT_SRC);
    // Distinct keys — neither click writes the other's key — and each key
    // brings its own synthesized page cursor.
    expect(config.variables["menus.themeMenu.applyTheme"]).toBeDefined();
    expect(config.variables["menus.styleMenu.applyStyle"]).toBeDefined();
    expect(config.variables["menus.themeMenu.applyTheme.page"]).toBeDefined();
    expect(config.variables["menus.styleMenu.applyStyle.page"]).toBeDefined();

    clickToggle(render(), "menus.themeMenu.applyTheme", "applyTheme");
    let out = stripAnsi(render());
    expect(out).toContain("T ▾");
    expect(out).toContain("S ▸"); // style still closed — independence
    // Open style too: theme stays open (NOT mutually exclusive).
    clickToggle(render(), "menus.styleMenu.applyStyle", "applyStyle");
    out = stripAnsi(render());
    expect(out).toContain("T ▾");
    expect(out).toContain("S ▾"); // both open
    expect(stripAnsi(render()).split("\n").length).toBeGreaterThanOrEqual(3); // row0 + 2 drops
    dispose();
  });
});

// Two menus in ONE row sharing the key "pickers" (the dict option) ⇒ ACCORDION.
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
    themeMenu: { template: 'T {{ menu "applyTheme" (dict "key" "pickers") }}', bg: 'surface', fg: 'foreground' },
    styleMenu: { template: 'S {{ menu "applyStyle" (dict "key" "pickers") }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['themeMenu', 'styleMenu'] },
}`;

describe("opt-in accordion (shared key, one open at a time)", () => {
  test("both menus share the key; the gate unions members; ONE shared page cursor; opening one closes the other", () => {
    const { config, render, clickToggle, dispose } = buildRuntime(ACCORDION_SRC);
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
    // One page cursor per disclosure key: the accordion holds at most one open
    // body, so its one cursor is exact — and every toggle resets it to 0.
    expect(config.variables["menus.pickers.page"]).toEqual({
      kind: "state",
      key: "menus.pickers.page",
      default: "0",
    });

    clickToggle(render(), "menus.pickers", "applyTheme");
    let out = stripAnsi(render());
    expect(out).toContain("T ▾");
    expect(out).toContain("S ▸");
    // styleMenu renders closed (current "applyTheme" is outside its cycle), so
    // its click writes "applyStyle" — opening it auto-closes the theme.
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
        a: { template: 'A {{ menu "applyTheme" (dict "key" "k") }}', bg: 'surface', fg: 'foreground' },
        b: { template: 'B {{ menu "applyTheme" (dict "key" "k") }}', bg: 'surface', fg: 'foreground' },
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

// THE "theme tester": three menus in ONE segment, with content between/after.
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
    tester: { template: 'TEST {{ menu "applyTheme" }} | {{ menu "applyStyle" }} | {{ menu "applyTheme2" }} END', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['tester'] },
}`;

describe('the "theme tester" — N menus in one segment', () => {
  test("each menu is a DISTINCT addressable disclosure (no identity collision)", () => {
    const config = parseAndValidate("<test>", TESTER_SRC, ALLOWED);
    expect(config.variables["menus.tester.applyTheme"]).toBeDefined();
    expect(config.variables["menus.tester.applyStyle"]).toBeDefined();
    expect(config.variables["menus.tester.applyTheme2"]).toBeDefined();
    // Three distinct state keys + their three page cursors, all synthesized
    // from one segment — the old (rowKey,segName) identity would have
    // collapsed all three to one.
    const menuKeys = Object.keys(config.variables).filter((k) =>
      k.startsWith("menus."),
    );
    expect(menuKeys).toHaveLength(6);
  });

  test("closed: all three glyphs inline with the separators + END on one row", () => {
    const { render, dispose } = buildRuntime(TESTER_SRC);
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TEST ▸ | ▸ | ▸ END"); // mid-segment content stays inline
    dispose();
  });

  test("a mid-segment menu keeps content AFTER it on row 0; its body drops below", () => {
    const { render, clickToggle, dispose } = buildRuntime(TESTER_SRC);
    // Open only the FIRST menu (mid-segment, followed by ' | ▸ | ▸ END').
    clickToggle(render(), "menus.tester.applyTheme", "applyTheme");
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(2); // row 0 + one drop
    // The first glyph flipped, and EVERYTHING after it is still on row 0 —
    // the defect this redesign fixes (no `\n` dragging the tail down).
    expect(lines[0]).toContain("TEST ▾ | ▸ | ▸ END");
    expect(lines[0]).not.toContain("✕"); // the opened body is not on row 0
    expect(lines[1]).toContain("✕"); // it dropped below
    dispose();
  });

  test("all three open independently: three bodies stack below one inline row", () => {
    const { render, clickToggle, dispose } = buildRuntime(TESTER_SRC);
    clickToggle(render(), "menus.tester.applyTheme", "applyTheme");
    clickToggle(render(), "menus.tester.applyStyle", "applyStyle");
    clickToggle(render(), "menus.tester.applyTheme2", "applyTheme2");
    const lines = stripAnsi(render()).split("\n");
    expect(lines[0]).toContain("TEST ▾ | ▾ | ▾ END"); // all three open, all inline
    expect(lines).toHaveLength(4); // row 0 + three dropped bodies
    dispose();
  });
});

describe("compose substrate (drops stack, single-line rows unchanged)", () => {
  // A genuinely 2-line segment (authored "\n") beside a single-line neighbor.
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
    expect(lines[0]).toContain("ONE"); // neighbor zipped onto row 0
    expect(lines[0]).toContain("TOP"); // child's first line on row 0
    expect(lines[0]).not.toContain("DROP"); // overflow NOT zipped onto row 0
    expect(lines[1]).toContain("DROP"); // stacked below
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

// ─── The open-domain claim, end to end (candybar-config-engine-71o.5) ────────
//
// [LAW:verifiable-goals] The epic's own acceptance bullet: "Adding a menu
// over a NEW config field with an enumerable domain requires only config
// data — zero engine edits." 71o.1 (test/dsl-actions.test.ts's "inline
// literal option domain" describe block) already proved this for `{{ action
// }}` bound directly to each value; this proves the SAME claim for
// `{{ menu }}` — the picker DISCLOSURE a real settings surface actually
// uses — which had never been exercised over an inline `from: [...]`
// domain. "Zero engine edits" is asserted by construction: this file ships
// only a JSON5 string (`SRC` below) and calls the same `buildRuntime`/
// `parseAndValidate`/`registerDslConfig` every other test in this suite
// calls — no src/ file changes accompany this test.

describe("candybar-config-engine-71o.5 — a brand-new field gets a {{ menu }} via inline domain alone", () => {
  // "sound-effects" is not a field any built-in segment, action, or domain
  // registry knows about — proving the claim requires a field the engine
  // has literally never seen, not one of the pre-registered "themes" /
  // "styles" / "looks" domains.
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
        template: '\u{1F50A} {{ .soundEffects }} {{ menu "applySound" }}',
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
      effectsOf(u).some(
        (e) => e.verb === "set-state" && e.args[2] === "buzz",
      ),
    );
    expect(buzzUrl).toBeDefined();
    click(buzzUrl!);

    expect(sessionState.get("s1", "sound-effects")).toBe("buzz");

    // The gate is the inline domain itself — an out-of-domain value is
    // rejected loudly, proving the click passed a REAL derived allow-list
    // (mirrors 71o.1's own "outside the inline domain is rejected loudly"
    // assertion in test/dsl-actions.test.ts), not an unconditional write.
    const rejected = validateStateWrite("sound-effects", "explosion");
    expect(rejected.ok).toBe(false);
    dispose();
  });
});
