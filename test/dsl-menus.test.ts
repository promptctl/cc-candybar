// [LAW:verifiable-goals] Self-contained menu acceptance, driven through the real
// spine (registerDslConfig + renderDsl), the real loader (parse → validate → menu
// synthesis), and the real set-state gate — never a parallel rig. Covers the
// pdu.5/.7/.9 redesign: a menu's body rides a SEPARATE drop channel (not a `\n`
// in the inline stream), so a menu may sit ANYWHERE in a segment and a segment
// may hold ANY NUMBER of menus; identity is (stateKey, member=apply-name) with an
// INDEPENDENT default key and an OPT-IN shared key for accordion grouping.
//
//   1. A `{{ menu }}` SYNTHESIZES a state var + cycle action under the reserved
//      `menus.` namespace, identity = (segment + apply name); the gate derives
//      through the one path. No author-named key (independent) by default.
//   2. Toggle round trip: closed renders ▸ and no body; the click writes the
//      member; the next render shows ▾ + the picker body dropped BELOW the row;
//      a second click closes.
//   3. Independent default: two menus (no key) are not mutually exclusive — both
//      can be open at once. Opt-in shared key: two menus sharing a key are an
//      accordion (opening one closes the other).
//   4. N menus in ONE segment (the "theme tester"): each is a distinct, addressable
//      disclosure; mid-segment menus keep content after them inline on row 0; all
//      bodies stack below the row.
//   5. The open menu's segment is focus-tinted; composeBlocks stacks drops while
//      all-single-line rows are unchanged.

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
    colorCompatibility: "truecolor" as const, wrap: true, padding: 0,
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
// `menus.themepicker.applyTheme`, member `applyTheme`.
const MENU_SRC = `{
  globals: {},
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    themePage: { set: 'theme-page', int: true },
  },
  segments: {
    label: { template: 'PICK', bg: 'surface', fg: 'foreground' },
    themepicker: { template: '🎨 {{ menu "applyTheme" "themePage" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['label', 'themepicker'] },
}`;

const TKEY = "menus.themepicker.applyTheme";

describe("menu synthesis (derived identity, reserved namespace)", () => {
  test("synthesizes a state var + cycle action keyed by (segment, apply); gate derives", () => {
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
    const gate = deriveActionValidators(config).find((g) => g.key === TKEY);
    expect(gate?.spec).toEqual({
      kind: "allow-list",
      allowed: ["closed", "applyTheme"],
    });
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
      actions: { closed: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: { s: { template: '{{ menu "closed" "themePage" }}', bg: 'surface', fg: 'foreground' } },
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
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: { s: { template: '{{ menu .applyVar "themePage" }}', bg: 'surface', fg: 'foreground' } },
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
        themePage: { set: 'theme-page', int: true },
        stylePage: { set: 'style-page', int: true },
      },
      segments: { s: { template: 'S {{ menu "a-b" "themePage" }} {{ menu "a_b" "stylePage" }}', bg: 'surface', fg: 'foreground' } },
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
      actions: { themePage: { set: 'theme-page', int: true } },
      segments: { s: { template: '{{ menu "" "themePage" }}', bg: 'surface', fg: 'foreground' } },
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

  test("a {{ menu }} referencing an unknown apply/page action is a LOAD error (not render-time)", () => {
    // The menu binds (apply, page) just like a picker; cross-ref must catch a
    // missing action at load, not defer to renderPicker.requireKind on open.
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: { s: { template: '{{ menu "applyTheme" "noSuchPage" }}', bg: 'surface', fg: 'foreground' } },
      root: { h: ['s'] },
    }`;
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/unknown action "noSuchPage" \(in a picker or menu\)/);
    }
  });

  test("a {{ menu }} with an empty shared key is rejected (bare menus. key)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: { s: { template: '{{ menu "applyTheme" "themePage" false false "" }}', bg: 'surface', fg: 'foreground' } },
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
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: { s: { template: 'X', bg: '{{ menu "applyTheme" "themePage" }}', fg: 'foreground' } },
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
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: { m: { template: 'M {{ menu "applyTheme" "themePage" }}', bg: 'surface', fg: 'foreground' } },
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
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      helpers: { mkMenu: '{{ menu "applyTheme" "themePage" }}' },
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
  // ONE atomic set-state that toggles the open-state AND resets the page cursor to
  // page 0 — mirroring the picker's closeOnPick page-reset fold — so a reopened
  // menu is never stranded on a stale page left by ←/→ before the last close.
  test("disclosure click resets the page cursor to 0 in the same atomic write", () => {
    const { render, dispose } = buildRuntime(MENU_SRC);
    const url = extractUrls(render()).find((u) =>
      effectsOf(u).some((e) => e.args[1] === TKEY),
    );
    if (!url) throw new Error("no disclosure toggle rendered");
    const eff = effectsOf(url)[0]!;
    // [sessionId, openStateKey, successor, pageKey, "0"] — open-state + page reset
    // in one batch. Both keys are independently gated; the batch passes one gate.
    expect(eff.args.slice(1)).toEqual([TKEY, "applyTheme", "theme-page", "0"]);
    dispose();
  });
});

// Two menus in ONE row, neither naming a key ⇒ INDEPENDENT.
const INDEPENDENT_SRC = `{
  globals: {},
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    themePage: { set: 'theme-page', int: true },
    applyStyle: { set: 'style', from: 'styles' },
    stylePage: { set: 'style-page', int: true },
  },
  segments: {
    themeMenu: { template: 'T {{ menu "applyTheme" "themePage" }}', bg: 'surface', fg: 'foreground' },
    styleMenu: { template: 'S {{ menu "applyStyle" "stylePage" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['themeMenu', 'styleMenu'] },
}`;

describe("independent default (no shared key)", () => {
  test("two menus have distinct keys; both can be open at once", () => {
    const { config, render, clickToggle, dispose } =
      buildRuntime(INDEPENDENT_SRC);
    // Distinct keys — neither click writes the other's key.
    expect(config.variables["menus.themeMenu.applyTheme"]).toBeDefined();
    expect(config.variables["menus.styleMenu.applyStyle"]).toBeDefined();

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

// Two menus in ONE row sharing the key "pickers" ⇒ ACCORDION.
const ACCORDION_SRC = `{
  globals: {},
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    themePage: { set: 'theme-page', int: true },
    applyStyle: { set: 'style', from: 'styles' },
    stylePage: { set: 'style-page', int: true },
  },
  segments: {
    themeMenu: { template: 'T {{ menu "applyTheme" "themePage" false false "pickers" }}', bg: 'surface', fg: 'foreground' },
    styleMenu: { template: 'S {{ menu "applyStyle" "stylePage" false false "pickers" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['themeMenu', 'styleMenu'] },
}`;

describe("opt-in accordion (shared key, one open at a time)", () => {
  test("both menus share the key; the gate unions members; opening one closes the other", () => {
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
      actions: { applyTheme: { set: 'theme', from: 'themes' }, themePage: { set: 'theme-page', int: true } },
      segments: {
        a: { template: 'A {{ menu "applyTheme" "themePage" false false "k" }}', bg: 'surface', fg: 'foreground' },
        b: { template: 'B {{ menu "applyTheme" "themePage" false false "k" }}', bg: 'surface', fg: 'foreground' },
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
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    tp: { set: 'theme-page', int: true },
    applyStyle: { set: 'style', from: 'styles' },
    sp: { set: 'style-page', int: true },
    applyTheme2: { set: 'theme', from: 'themes' },
    fp: { set: 'font-page', int: true },
  },
  segments: {
    tester: { template: 'TEST {{ menu "applyTheme" "tp" }} | {{ menu "applyStyle" "sp" }} | {{ menu "applyTheme2" "fp" }} END', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['tester'] },
}`;

describe('the "theme tester" — N menus in one segment', () => {
  test("each menu is a DISTINCT addressable disclosure (no identity collision)", () => {
    const config = parseAndValidate("<test>", TESTER_SRC, ALLOWED);
    expect(config.variables["menus.tester.applyTheme"]).toBeDefined();
    expect(config.variables["menus.tester.applyStyle"]).toBeDefined();
    expect(config.variables["menus.tester.applyTheme2"]).toBeDefined();
    // Three distinct state keys synthesized from one segment — the old
    // (rowKey,segName) identity would have collapsed all three to one.
    const menuKeys = Object.keys(config.variables).filter((k) =>
      k.startsWith("menus."),
    );
    expect(menuKeys).toHaveLength(3);
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
