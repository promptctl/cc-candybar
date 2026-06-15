// [LAW:verifiable-goals] Self-contained menu acceptance (render-bugs-pdu.9),
// driven through the real spine (registerDslConfig + renderDsl), the real loader
// (parse → validate → menu synthesis), and the real set-state gate — never a
// parallel rig. Folds in .5 (disclosure toggle) and .7 (menu position):
//
//   1. A `{{ menu }}` in a segment template SYNTHESIZES its accordion state var +
//      cycle action under the reserved `menus.` namespace, keyed by the segment's
//      enclosing-horizontal-container path (the row IS the key) — the author
//      names neither the key nor the menu. The gate derives through the one path.
//   2. Toggle round trip: closed renders ▸ and no body; the click writes the
//      menu's member name; the next render shows ▾ + the picker body dropped onto
//      its own line BELOW the row (compose stacks drops); the second click closes.
//   3. Auto-scoped accordion: two menus in one horizontal row share the derived
//      row key with ZERO key authoring, so opening one closes the other.
//   4. The open menu's segment is focus-tinted (its background lightened).
//   5. composeBlocks: a drop stacks full-width below row 0; all-single-line rows
//      are unchanged (no spurious blank line, neighbors unmoved).

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
    colorCompatibility: "truecolor" as const,
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

// A theme picker menu beside a plain label, in one horizontal row. The row IS
// `root` (a horizontal container), so the derived row key is `menus.root`.
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

describe("pdu.9 — menu synthesis (derived, reserved namespace)", () => {
  test("synthesizes a state var + cycle action under menus.*, and the gate derives", () => {
    const config = parseAndValidate("<test>", MENU_SRC, ALLOWED);
    expect(config.variables["menus.root"]).toEqual({
      kind: "state",
      key: "menus.root",
      default: "closed",
    });
    expect(config.actions["menus.root.themepicker"]).toEqual({
      set: "menus.root",
      cycle: ["closed", "themepicker"],
    });
    const gate = deriveActionValidators(config).find(
      (g) => g.key === "menus.root",
    );
    expect(gate?.spec).toEqual({
      kind: "allow-list",
      allowed: ["closed", "themepicker"],
    });
  });

  test("a {{ menu }} inside a helper is rejected at load (no per-placement identity)", () => {
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

  test("a user name under the reserved namespace is rejected", () => {
    const src = MENU_SRC.replace(
      "'session.id': { kind: 'input', path: 'session_id', default: '' }",
      "'session.id': { kind: 'input', path: 'session_id', default: '' }, 'menus.mine': { kind: 'literal', value: 'v' }",
    );
    try {
      parseAndValidate("<test>", src, ALLOWED);
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/reserved "menus\." namespace/);
    }
  });
});

describe("pdu.9 — toggle round trip + drop stacking", () => {
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
    clickToggle(render(), "menus.root", "themepicker");
    expect(sessionState.get("s1", "menus.root")).toBe("themepicker");
    const lines = stripAnsi(render()).split("\n");
    expect(lines).toHaveLength(2); // row 0 + the dropped body
    expect(lines[0]).toContain("PICK"); // neighbor unmoved on row 0
    expect(lines[0]).toContain("🎨 ▾"); // disclosure flipped, still inline
    expect(lines[0]).not.toContain("✕"); // body is NOT zipped onto row 0
    expect(lines[1]).toContain("✕"); // body dropped onto its own full-width line
    // second click closes
    clickToggle(render(), "menus.root", "closed");
    expect(stripAnsi(render()).split("\n")).toHaveLength(1);
    dispose();
  });

  test("the open menu's segment is focus-tinted (a new background appears)", () => {
    const { render, clickToggle, dispose } = buildRuntime(MENU_SRC);
    const closedBgs = bgCodes(render());
    clickToggle(render(), "menus.root", "themepicker");
    const openBgs = bgCodes(render());
    // Opening lightens the menu segment's surface → a background present open
    // that was not present closed.
    const added = [...openBgs].filter((c) => !closedBgs.has(c));
    expect(added.length).toBeGreaterThan(0);
    dispose();
  });
});

// Two theme/style menus in ONE horizontal row, neither naming a key.
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
    themeMenu: { template: 'T {{ menu "applyTheme" "themePage" }}', bg: 'surface', fg: 'foreground' },
    styleMenu: { template: 'S {{ menu "applyStyle" "stylePage" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { h: ['themeMenu', 'styleMenu'] },
}`;

describe("pdu.9 — auto-scoped accordion (one open per row, zero key authoring)", () => {
  test("both menus share the derived row key; opening one closes the other", () => {
    const { config, render, clickToggle, dispose } = buildRuntime(ACCORDION_SRC);
    // Both cycle actions write the SAME derived key (the row), unioned into one gate.
    expect(config.actions["menus.root.themeMenu"]).toEqual({
      set: "menus.root",
      cycle: ["closed", "themeMenu"],
    });
    expect(config.actions["menus.root.styleMenu"]).toEqual({
      set: "menus.root",
      cycle: ["closed", "styleMenu"],
    });
    const gate = deriveActionValidators(config).find(
      (g) => g.key === "menus.root",
    );
    expect(gate?.spec).toEqual({
      kind: "allow-list",
      allowed: ["closed", "themeMenu", "styleMenu"],
    });

    clickToggle(render(), "menus.root", "themeMenu");
    let out = stripAnsi(render());
    expect(out).toContain("T ▾");
    expect(out).toContain("S ▸");
    // styleMenu's toggle renders closed (current "themeMenu" is outside its
    // cycle), so its click writes "styleMenu" — opening it auto-closes the theme.
    clickToggle(render(), "menus.root", "styleMenu");
    out = stripAnsi(render());
    expect(out).toContain("T ▸");
    expect(out).toContain("S ▾");
    dispose();
  });
});

describe("pdu.9 — compose substrate (drops stack, single-line rows unchanged)", () => {
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
