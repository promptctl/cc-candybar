// [LAW:verifiable-goals] k5a.6 acceptance, driven through the real spine
// (registerDslConfig + renderDsl) and the real loader (parseAndValidate):
//
//   1. Width injection — renderDsl exposes opts.width as `.term.cols`, the same
//      number FlexStrip wraps to; never cached, re-read every render.
//   2. Row-level `when` — a row is a pure function of state; a hidden row does
//      not exist (no blank line), and visible rows keep positionally-stable hue.
//   3. The `menu` widget — a width-paginated option run with derived ←/→/✕
//      affordances; option clicks apply-and-close via the batched set-state wire.
//   4. paginate() — the pure pagination function in isolation.
//   5. The menu's page key gets an integer validator DERIVED from the widget.

import { PaletteResolver, RichText, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { paginate } from "../src/render/widget";
import { SessionState } from "../src/daemon/session-state";
import { effectsOf } from "./helpers/click";
import { listResolvablePaletteNames, STYLE_ORDER } from "../src/themes/policy";
import {
  makeIntValidator,
  deriveWidgetValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width: number) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    width,
  };
}

// Extract the non-empty OSC-8 OPEN urls (the close sequence carries "").
function extractUrls(rendered: string): string[] {
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function buildRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { store });
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (width: number): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId },
      basePalette,
      opts(width),
    );
  return { config, store, registry, sessionState, render };
}

// ─── Pillar 1: width injection ───────────────────────────────────────────────

describe("k5a.6 — width injection (term.cols)", () => {
  const SRC = `{
    globals: { palette: 'textual-dark' },
    variables: {
      'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    },
    segments: { w: { template: 'cols={{ .term.cols }}', bg: 'surface', fg: 'foreground' } },
    layout: [['w']],
  }`;

  test("renderDsl exposes opts.width as .term.cols", () => {
    const { render } = buildRuntime(SRC);
    expect(stripAnsi(render(137))).toContain("cols=137");
  });

  test("a resize is just a new value on the same path (never cached)", () => {
    const { render } = buildRuntime(SRC);
    expect(stripAnsi(render(100))).toContain("cols=100");
    // Re-render at a different width with NO reload — the value must update.
    expect(stripAnsi(render(42))).toContain("cols=42");
  });
});

// ─── Pillar 2: row-level when ────────────────────────────────────────────────

describe("k5a.6 — row-level when", () => {
  const SRC = `{
    globals: { palette: 'textual-dark' },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      open: { kind: 'state', key: 'open', default: '0' },
    },
    segments: {
      top: { template: 'TOP', bg: 'surface', fg: 'foreground' },
      bot: { template: 'BOT', bg: 'surface', fg: 'foreground' },
    },
    layout: [
      ['top'],
      { when: '{{ eq .open "1" }}', segments: ['bot'] },
    ],
  }`;

  test("a false-when row does not exist — no blank line", () => {
    const { render } = buildRuntime(SRC);
    const out = render(80);
    expect(out.includes("\n")).toBe(false); // single line, not "TOP\n"
    expect(stripAnsi(out)).toContain("TOP");
    expect(stripAnsi(out)).not.toContain("BOT");
  });

  test("a true-when row renders as a real second line", () => {
    const { render, sessionState } = buildRuntime(SRC);
    sessionState.set("s1", "open", "1");
    const out = render(80);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[1]!)).toContain("BOT");
  });
});

// ─── paginate (pure) ─────────────────────────────────────────────────────────

describe("k5a.6 — paginate()", () => {
  test("everything fits → one page", () => {
    expect(paginate([3, 3, 3], 100, 0)).toEqual([[0, 1, 2]]);
  });

  test("overflow splits into pages, reserving arrow space", () => {
    // usable = 20 - 6 = 14. items width 6 each + 1 separator = 6,13,20→split.
    expect(paginate([6, 6, 6], 20, 6)).toEqual([[0, 1], [2]]);
  });

  test("an oversized lone item gets its own page (cannot be split)", () => {
    expect(paginate([50, 4], 20, 0)).toEqual([[0], [1]]);
  });

  test("infinite width collapses to one page", () => {
    expect(paginate([10, 10, 10], Number.POSITIVE_INFINITY, 6)).toEqual([
      [0, 1, 2],
    ]);
  });

  test("empty input → no pages", () => {
    expect(paginate([], 80, 6)).toEqual([]);
  });
});

// ─── Pillar 3: the menu widget ───────────────────────────────────────────────

const MENU_SRC = `{
  globals: { palette: 'textual-dark' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    theme: { kind: 'state', key: 'theme', default: 'textual-dark' },
    themePage: { kind: 'state', key: 'theme-page', default: '-1' },
  },
  widgets: {
    themeMenu: {
      kind: 'menu',
      state: 'theme-page',
      items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }],
    },
  },
  segments: {
    trigger: { template: 'T', bg: 'surface', fg: 'foreground' },
    menu: { template: '{{ widget "themeMenu" }}', bg: 'surface', fg: 'foreground' },
  },
  layout: [
    ['trigger'],
    { when: '{{ ge (int .themePage) 0 }}', segments: ['menu'] },
  ],
}`;

describe("k5a.6 — menu widget", () => {
  test("closed (page -1): the menu row does not render", () => {
    const { render } = buildRuntime(MENU_SRC);
    const out = render(80);
    expect(out.includes("\n")).toBe(false);
    expect(extractUrls(out)).toEqual([]); // no clickable affordances
  });

  test("open at a wide width: every option, no arrows, one close ✕", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "0");
    const out = render(Number.POSITIVE_INFINITY);
    const line = out.split("\n")[1]!;
    const urls = extractUrls(line);
    const themeCount = listResolvablePaletteNames().length;
    // close + one per theme
    expect(urls).toHaveLength(themeCount + 1);
    // ✕ is one set-state effect closing the page.
    expect(effectsOf(urls[0]!)).toEqual([
      { verb: "set-state", args: ["s1", "theme-page", "-1"] },
    ]);
    // every option click APPLIES theme AND closes (page -1) in one batched
    // set-state effect.
    for (const u of urls.slice(1)) {
      const effects = effectsOf(u);
      expect(effects).toHaveLength(1);
      const { verb, args } = effects[0]!;
      expect(verb).toBe("set-state");
      expect(args.slice(0, 2)).toEqual(["s1", "theme"]);
      expect(args.slice(3)).toEqual(["theme-page", "-1"]);
    }
    expect(stripAnsi(line)).not.toContain("→");
    expect(stripAnsi(line)).not.toContain("←");
  });

  test("open at a narrow width: paginates with a forward arrow on page 0", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "0");
    const line = render(34).split("\n")[1]!;
    expect(stripAnsi(line)).toContain("→");
    expect(stripAnsi(line)).not.toContain("←"); // page 0 has no back arrow
    // the forward arrow navigates to page 1 (render-computed)
    expect(extractUrls(line).map(effectsOf)).toContainEqual([
      { verb: "set-state", args: ["s1", "theme-page", "1"] },
    ]);
    // fewer options than the full set fit on the page (an option click sets the
    // `theme` key; the ←/→/✕ affordances set only `theme-page`)
    const optionUrls = extractUrls(line).filter((u) =>
      effectsOf(u).some((e) => e.args[1] === "theme"),
    );
    expect(optionUrls.length).toBeLessThan(listResolvablePaletteNames().length);
  });

  test("navigating to a later page shows a back arrow", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "1");
    const line = render(34).split("\n")[1]!;
    expect(stripAnsi(line)).toContain("←");
    expect(extractUrls(line).map(effectsOf)).toContainEqual([
      { verb: "set-state", args: ["s1", "theme-page", "0"] },
    ]);
  });

  test("a page beyond range clamps to the last page (back arrow, no forward)", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "9999");
    const line = render(34).split("\n")[1]!;
    expect(stripAnsi(line)).toContain("←");
    expect(stripAnsi(line)).not.toContain("→");
  });

  test("arrow reservation is not self-fulfilling: a run that fits with just ✕ stays one page", () => {
    // [LAW:dataflow-not-control-flow] At the boundary width where the option run
    // fits on one page reserving ONLY the close glyph, the menu must NOT reserve
    // arrow space and split — that would make ←/→ appear unnecessarily. Compute
    // the exact boundary from measured widths so the assertion is deterministic.
    const STYLE_MENU_SRC = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
        sp: { kind: 'state', key: 'style-page', default: '-1' },
        style: { kind: 'state', key: 'style', default: 'surface' },
      },
      widgets: { sm: { kind: 'menu', state: 'style-page', items: [{ optionsFrom: 'styles', onClick: { set: 'style' } }] } },
      segments: { m: { template: '{{ widget "sm" }}', bg: 'surface', fg: 'foreground' } },
      layout: [{ when: '{{ ge (int .sp) 0 }}', segments: ['m'] }],
    }`;
    const w = (s: string): number => new RichText(s).cellLength;
    const sumOpts =
      STYLE_ORDER.reduce((a, s) => a + w(s), 0) + (STYLE_ORDER.length - 1);
    const closeReserve = w("✕") + 1;
    const boundary = sumOpts + closeReserve; // fits one page with close-only

    const { render, sessionState } = buildRuntime(STYLE_MENU_SRC);
    sessionState.set("s1", "style-page", "0");
    // This config has a single (menu) row, so the rendered menu is line 0.
    const line = render(boundary).split("\n")[0]!;
    // Reserving both arrows here would overflow → split → a → would appear.
    // The two-pass logic keeps it one page with no navigation arrows.
    expect(stripAnsi(line)).not.toContain("→");
    expect(stripAnsi(line)).not.toContain("←");
    // All four styles are present on the single page.
    for (const s of STYLE_ORDER) expect(stripAnsi(line)).toContain(s);
  });

  test("the currently-selected theme is marked active (bold)", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "0");
    sessionState.set("s1", "theme", "textual-dark");
    // bold SGR (1) wraps the active option's text
    const line = render(Number.POSITIVE_INFINITY).split("\n")[1]!;
    expect(line).toMatch(/\x1b\[[0-9;]*1[;m].*textual-dark/);
  });
});

// ─── Pillar 4: derived integer validator ─────────────────────────────────────

describe("k5a.6 — menu page-key validator", () => {
  test("makeIntValidator accepts integers (incl. -1) and canonicalizes", () => {
    const v = makeIntValidator("page");
    expect(v("-1")).toEqual({ ok: true, value: "-1" });
    expect(v("0")).toEqual({ ok: true, value: "0" });
    expect(v("007")).toEqual({ ok: true, value: "7" });
    expect(v("-0")).toEqual({ ok: true, value: "0" });
    expect(v("-007")).toEqual({ ok: true, value: "-7" });
    expect(v("")).toEqual({ ok: false, reason: expect.any(String) });
    expect(v("1.5")).toEqual({ ok: false, reason: expect.any(String) });
    expect(v("x")).toEqual({ ok: false, reason: expect.any(String) });
    // Large magnitude stays an exact decimal string — NOT scientific notation
    // (which would read back as a different number).
    const big = "1000000000000000000000"; // 1e21
    expect(v(big)).toEqual({ ok: true, value: big });
  });

  test("deriveWidgetValidators derives an int spec for a menu page key", () => {
    const config = parseAndValidate("<test>", MENU_SRC, ALLOWED);
    const derived = deriveWidgetValidators(config);
    // The menu writes its page key (int) and the baseline `theme` key (skipped),
    // so the only derived key is the page key.
    expect(derived.map((d) => d.key)).toEqual(["theme-page"]);
    expect(derived[0]!.spec).toEqual({ kind: "int" });
  });

  test("a menu page key colliding with a baseline key IS derived (so registration throws loudly)", () => {
    // [LAW:no-silent-fallbacks] A menu naming its page key `theme` is a
    // misconfiguration. Deriving the int validator anyway makes
    // registerStateValidator throw on the duplicate at load — loud — rather than
    // silently leaving the theme allow-list gate to reject the menu's integer
    // page writes confusingly at click time.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
        theme: { kind: 'state', key: 'theme', default: 'textual-dark' },
      },
      widgets: { m: { kind: 'menu', state: 'theme', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "m" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(deriveWidgetValidators(config).map((d) => d.key)).toEqual(["theme"]);
  });

  test("a menu config without session.id fails at load (navigation needs it)", () => {
    // [LAW:verifiable-goals] A menu always emits set-state navigation URLs
    // (✕/←/→), whose first segment is session.id — so a menu needs the global
    // session.id even when its items carry no set actions. Surface at load.
    const src = `{
      globals: {},
      variables: {
        'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
        p: { kind: 'state', key: 'p', default: '-1' },
      },
      widgets: { m: { kind: 'menu', state: 'p', items: [{ glyph: 'x', onClick: { copy: 'hi' } }] } },
      segments: { s: { template: '{{ widget "m" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(/session\.id/);
  });

  test("a menu whose state key has no backing state variable fails at load", () => {
    // [LAW:verifiable-goals] Navigation writes the page key; without a
    // kind:"state" variable reading it, the writes are inert. Surface at load.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
      },
      widgets: { m: { kind: 'menu', state: 'orphan-page', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "m" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(
      /orphan-page/,
    );
  });

  test("a menu config without term.cols fails at load (not at render)", () => {
    // [LAW:verifiable-goals] The menu paginates against term.cols; a config that
    // declares a menu but not the width variable is surfaced at config-load with
    // a clear message, not a render-time "Unknown variable".
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' }, p: { kind: 'state', key: 'p', default: '-1' } },
      widgets: { m: { kind: 'menu', state: 'p', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "m" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(
      /term\.cols/,
    );
  });

  test("a menu config with a mis-shaped term.cols fails at load", () => {
    // [LAW:verifiable-goals] A term.cols that isn't the input var width
    // injection targets (wrong kind, or input reading a different path) never
    // receives the injected width — the menu would silently paginate against
    // the stale default. Validate the shape, not just presence.
    const wrongKind = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        p: { kind: 'state', key: 'p', default: '-1' },
        'term.cols': { kind: 'literal', value: 80 },
      },
      widgets: { m: { kind: 'menu', state: 'p', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "m" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    expect(() => parseAndValidate("<test>", wrongKind, ALLOWED)).toThrow(
      /term\.cols/,
    );
    const wrongPath = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        p: { kind: 'state', key: 'p', default: '-1' },
        'term.cols': { kind: 'input', path: 'something.else', type: 'number', default: 80 },
      },
      widgets: { m: { kind: 'menu', state: 'p', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "m" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    expect(() => parseAndValidate("<test>", wrongPath, ALLOWED)).toThrow(
      /term\.cols/,
    );
    // Wrong type: width is injected as a number; a non-number type coerces it
    // (e.g. boolean → true → 1) and the menu paginates against a broken width.
    const wrongType = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        p: { kind: 'state', key: 'p', default: '-1' },
        'term.cols': { kind: 'input', path: 'term.cols', type: 'boolean', default: false },
      },
      widgets: { m: { kind: 'menu', state: 'p', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "m" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    expect(() => parseAndValidate("<test>", wrongType, ALLOWED)).toThrow(
      /term\.cols/,
    );
  });

  test("baseline keys are not re-derived (buttons writing theme)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      widgets: { p: { kind: 'buttons', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "p" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(deriveWidgetValidators(config)).toEqual([]);
  });

  test("buttons writing a custom key derive a unioned allow-list spec", () => {
    // [LAW:one-source-of-truth] The allow-list members ARE every value the
    // buttons can produce — the two fixed `to` values union into one gate, so a
    // click on either is deliverable and nothing else is.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        viewMode: { kind: 'state', key: 'viewMode', default: 'full' },
      },
      widgets: { p: { kind: 'buttons', items: [
        { glyph: 'F', label: 'full', onClick: { set: 'viewMode', to: 'full' } },
        { glyph: 'C', label: 'compact', onClick: { set: 'viewMode', to: 'compact' } },
      ] } },
      segments: { s: { template: '{{ widget "p" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    const derived = deriveWidgetValidators(config);
    expect(derived).toEqual([
      { key: "viewMode", spec: { kind: "allow-list", allowed: ["full", "compact"] } },
    ]);
  });

  test("an optionsFrom button on a custom key derives the resolved option list", () => {
    // [LAW:one-source-of-truth] An options picker's allow-list members are the
    // canonical theme list — the same source the renderer expands options from.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        bg: { kind: 'state', key: 'bg', default: '' },
      },
      widgets: { p: { kind: 'buttons', items: [
        { optionsFrom: 'themes', onClick: { set: 'bg' } },
      ] } },
      segments: { s: { template: '{{ widget "p" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    const derived = deriveWidgetValidators(config);
    expect(derived).toHaveLength(1);
    expect(derived[0]!.key).toBe("bg");
    expect(derived[0]!.spec).toEqual({
      kind: "allow-list",
      allowed: listResolvablePaletteNames(),
    });
  });

  test("a NON-integer value written to a menu page key throws at derivation", () => {
    // [LAW:no-silent-fallbacks] A menu page key is int-valued; a button writing a
    // non-integer value (here "v") to it is a genuine one-column-shape
    // contradiction no int validator could honor — surfaced at config-load, not
    // silently resolved to one shape. (An INTEGER write to the same key is legal
    // — that is the open-trigger pattern, covered by the next test.)
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
        shared: { kind: 'state', key: 'shared', default: '-1' },
      },
      widgets: {
        m: { kind: 'menu', state: 'shared', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] },
        b: { kind: 'buttons', items: [{ glyph: 'x', onClick: { set: 'shared', to: 'v' } }] },
      },
      segments: { s: { template: '{{ widget "m" }} {{ widget "b" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(() => deriveWidgetValidators(config)).toThrow(/non-integer value/);
  });

  test("a button writing an integer to a menu page key is the open trigger — derives one int spec, no throw", () => {
    // [LAW:types-are-the-program] The canonical menu-with-trigger pattern: a
    // `buttons` widget writing "0" to the menu's page key OPENS it (the only way
    // to move the page off its -1 closed sentinel — there is no open verb). The
    // literal "0" is an int WRITE gated by the page key's int validator, NOT a
    // second allow-list column, so derivation yields exactly one int spec for the
    // shared page key and does not throw. This is the live-config interaction the
    // earlier menu tests missed (they opened the menu via sessionState.set).
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
        themePage: { kind: 'state', key: 'theme-page', default: '-1' },
      },
      widgets: {
        open: { kind: 'buttons', items: [{ label: '▸', onClick: { set: 'theme-page', to: '0' } }] },
        menu: { kind: 'menu', state: 'theme-page', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] },
      },
      segments: { s: { template: '{{ widget "open" }} {{ widget "menu" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    const derived = deriveWidgetValidators(config);
    expect(derived).toEqual([{ key: "theme-page", spec: { kind: "int" } }]);
  });

  test("end-to-end: a custom-key config's clicks are accepted by the live gate", () => {
    // [LAW:verifiable-goals] The ticket's contract: a hand-authored config with
    // a custom writable button key has its clicks accepted on the set-state
    // wire. Drives the whole chain — real loader → derive → register → the live
    // validateStateWrite the set-state verb calls — exactly as the daemon's
    // RenderCache.buildState wires it, with no live socket.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        viewMode: { kind: 'state', key: 'viewMode', default: 'full' },
      },
      widgets: { p: { kind: 'buttons', items: [
        { glyph: 'F', label: 'full', onClick: { set: 'viewMode', to: 'full' } },
        { glyph: 'C', label: 'compact', onClick: { set: 'viewMode', to: 'compact' } },
      ] } },
      segments: { s: { template: '{{ widget "p" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    const disposers = deriveWidgetValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    try {
      // Both button-producible values are deliverable; anything else is rejected.
      expect(validateStateWrite("viewMode", "full")).toEqual({
        ok: true,
        value: "full",
      });
      expect(validateStateWrite("viewMode", "compact").ok).toBe(true);
      expect(validateStateWrite("viewMode", "huge").ok).toBe(false);
    } finally {
      for (const dispose of disposers) dispose();
    }
    // Dispose-before-swap parity: the key is gone once the config unloads.
    expect(validateStateWrite("viewMode", "full").ok).toBe(false);
  });
});
